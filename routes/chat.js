const express = require('express');
const router = express.Router();
const Dump = require('../models/Dump');
const auth = require('../middleware/auth');
const mongoose = require('mongoose');
const Group = require('../models/Group');
const { GoogleGenAI } = require("@google/genai");

// Initialize Gemini
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// @route   POST /api/chat
// @desc    Chat with your Second Brain (RAG)
// @access  Private
router.post('/', auth, async (req, res) => {
    if (!req.body) {
        return res.status(400).json({ msg: 'No data provided' });
    }
    try {
        const { message } = req.body; // User's question

        if (!message) {
            return res.status(400).json({ msg: "Message is required" });
        }

        // --- STEP 1: SEARCH (Find relevant notes) ---

        // A. Embed the user's question
        const embeddingResult = await genAI.models.embedContent({
            model: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2-preview',
            contents: [{ parts: [{ text: message }] }],
            config: {
                taskType: 'RETRIEVAL_QUERY',
                outputDimensionality: 768
            }
        });
        const queryVector = embeddingResult.embeddings[0].values;

        // Fetch groups the user belongs to for access control
        const myGroups = await Group.find({ members: req.user.id }).select('_id');
        const groupIds = myGroups.map(g => g._id);

        // B. Find top 5 relevant dumps
        let relevantDumps = await Dump.aggregate([
            {
                "$vectorSearch": {
                    "index": "vector_index",
                    "path": "embedding",
                    "queryVector": queryVector,
                    "numCandidates": 100,
                    "limit": 5
                }
            },
            {
                "$match": {
                    "$or": [
                        { "user": new mongoose.Types.ObjectId(req.user.id) },
                        { "group": { "$in": groupIds.map(id => new mongoose.Types.ObjectId(id)) }, "isPrivate": false }
                    ]
                }
            },
            { "$project": { "content": 1, "createdAt": 1, "title": 1 } }
        ]);

        // C. Fallback to Text Search if no semantic matches are found
        if (relevantDumps.length === 0) {
            relevantDumps = await Dump.find(
                {
                    $text: { $search: message },
                    $or: [
                        { user: req.user.id },
                        { group: { $in: groupIds }, isPrivate: false }
                    ]
                },
                { score: { $meta: "textScore" }, content: 1, createdAt: 1, title: 1 }
            )
                .sort({ score: { $meta: "textScore" } })
                .limit(5);
        }

        // --- STEP 2: CONSTRUCT CONTEXT ---

        // Turn the notes into a single string of text
        let contextText = "";
        if (relevantDumps.length > 0) {
            contextText = relevantDumps.map(dump =>
                `[Note from ${new Date(dump.createdAt).toLocaleDateString()}]: ${dump.content} titled "${dump.title || 'Untitled'}"`
            ).join("\n\n");
        } else {
            contextText = "No relevant notes found.";
        }

        // --- STEP 3: GENERATE ANSWER (The "Flash" Model) ---

        const prompt = `
        You are Cortex, a Second Brain AI. 
        Answer the user's question based STRICTLY on the context provided below.
        If the answer is not in the context, say "I don't have that information in your notes."
        
        USER QUESTION: "${message}"

        YOUR CONTEXT (User's Notes):
        ${contextText}
        `;

        const chatResult = await genAI.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ parts: [{ text: prompt }] }]
        });

        const aiResponse = chatResult.candidates[0].content.parts[0].text;
        relevantDumps = relevantDumps.map(d => ({ id: d._id.toString(), content: d.content, createdAt: d.createdAt })); // Clean up for frontend
        res.json({
            answer: aiResponse,
            sources: relevantDumps // Send back which notes it used
        });

    } catch (err) {
        console.error("Chat Error:", err);
        res.status(500).send('Server Error');
    }
});

module.exports = router;