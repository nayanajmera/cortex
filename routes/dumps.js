const express = require('express');
const router = express.Router();
const Dump = require('../models/Dump');
const auth = require('../middleware/auth'); // We need to create this middleware next
const mongoose = require('mongoose');
const Group = require('../models/Group');
const { GoogleGenAI } = require("@google/genai");

// Initialize Gemini
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const sanitizeDump = (dump) => {
    const plainDump = dump.toObject ? dump.toObject() : { ...dump };
    delete plainDump.embedding;
    return plainDump;
};

// @route   POST /api/dumps
// @desc    Create a new dump (and generate embedding)
// @access  Private (Logged in users only)
router.post('/', auth, async (req, res) => {
    if (!req.body) {
        return res.status(400).json({ msg: 'No data provided' });
    }
    try {
        const { content, group, tags } = req.body;
        let { title } = req.body;

        if (!content) {
            return res.status(400).json({ msg: 'Content is required' });
        }
        if (content.length > 16000) {
            return res.status(400).json({ msg: 'Content too long. Max 16,000 characters allowed.' });
        }
        if (content.trim().length === 0) {
            return res.status(400).json({ msg: 'Content cannot be empty' });
        }
        if (typeof content !== 'string') {
            return res.status(400).json({ msg: 'Content must be a string' });
        }

        if (title && typeof title !== 'string') {
            return res.status(400).json({ msg: 'Title must be a string' });
        }
        if (title && title.length > 100) {
            return res.status(400).json({ msg: 'Title too long. Max 100 characters allowed.' });
        }
        if (title && title.trim().length === 0) {
            title = undefined;
        }
        if (tags && !Array.isArray(tags)) {
            return res.status(400).json({ msg: 'Tags must be an array' });
        }
        if (tags && tags.length > 10) {
            return res.status(400).json({ msg: 'Too many tags. Max 10 allowed.' });
        }
        if (group && typeof group !== 'string') {
            return res.status(400).json({ msg: 'Hive ID must be a string' });
        }
        if (group) {
            const groupCheck = await Group.findById(group);

            if (!groupCheck) {
                return res.status(404).json({ msg: 'Hive not found' });
            }

            // Check if User ID exists in the Group's members array
            const isMember = groupCheck.members.some(
                member => member.toString() === req.user.id
            );

            if (!isMember) {
                return res.status(403).json({ msg: 'Access Denied: You are not a member of this Hive' });
            }
        }
        // LIMIT CHECK: Prevent crash if content is too long
        // 1 Token ~= 4 chars. 2048 tokens ~= 8192 chars.
        // We truncate to 8000 to be safe.
        const contentToEmbed = content.substring(0, 8000);

        // 1. Generate Embedding (Default 3072 dimensions, truncated to 768)
        const result = await genAI.models.embedContent({
            model: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2-preview',
            contents: [
                {
                    parts: [
                        {
                            text: contentToEmbed, // Send the safe truncated version
                        }
                    ]
                }
            ],
            config: {
                taskType: 'RETRIEVAL_DOCUMENT',
                outputDimensionality: 768
            }
        });

        const embedding = result.embeddings[0].values;

        // 2. Create the Dump object
        const newDump = new Dump({
            user: req.user.id,
            content, // Save the FULL content to DB (MongoDB handles up to 16MB)
            title,
            group: group || null,
            tags: tags || [],
            embedding: embedding,
            isPrivate: group ? false : true
        });

        const dump = await newDump.save();
        
        // --- WEBSOCKET BROADCAST ---
        if (group) {
            const io = req.app.get('io');
            if (io) {
                // Populate user info so the frontend can immediately display the creator's name
                await dump.populate('user', 'username name');
                io.to(group.toString()).emit('new_dump', sanitizeDump(dump));
            }
        }

        res.json(sanitizeDump(dump));

    } catch (err) {
        console.error("Error creating dump:", err); // Log full error object
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/dumps
// @desc    Get All Accessible Dumps (My Private + Group Public)
router.get('/', auth, async (req, res) => {
    try {
        // 1. Find all groups the user belongs to
        const myGroups = await Group.find({ members: req.user.id }).select('_id');
        const groupIds = myGroups.map(g => g._id);

        // 2. Complex Query:
        // A. Dumps created by ME (Private or Public) or
        // B. Dumps in MY GROUPS (that are NOT private)
        const dumps = await Dump.find({
            $or: [
                { user: req.user.id },
                { group: { $in: groupIds }, isPrivate: false }
            ]
        })
            .populate('user', 'username name') // Get owner details
            .populate('group', 'name')         // Get group name
            .sort({ createdAt: -1 });

        res.json(dumps.map(sanitizeDump));
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});
// @route   GET /api/dumps/search
// @desc    Search dumps using Vector Similarity (The "Brain" feature)
router.get('/search', auth, async (req, res) => {
    if (!req.query) {
        return res.status(400).json({ msg: 'No query provided' });
    }
    try {
        const { query } = req.query;
        if (!query) {
            return res.status(400).json({ msg: "Query is required" });
        }

        // 1. Convert the User's Search Query into a Vector
        // We use the EXACT same settings as when we saved the dump
        const result = await genAI.models.embedContent({
            model: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2-preview',
            contents: [
                {
                    parts: [{ text: query }]
                }
            ],
            config: {
                taskType: 'RETRIEVAL_QUERY',
                outputDimensionality: 768
            }
        });

        const queryVector = result.embeddings[0].values;
        // console.log(queryVector);

        // Fetch groups the user belongs to for access control
        const myGroups = await Group.find({ members: req.user.id }).select('_id');
        const groupIds = myGroups.map(g => g._id);

        // 2. Run the Aggregation Pipeline on MongoDB
        // This effectively says: "Find dumps where the 'embedding' field is close to 'queryVector'"
        let dumps = await Dump.aggregate([
            {
                "$vectorSearch": {
                    "index": "vector_index", // Name of index you created in Atlas
                    "path": "embedding",     // Field to search
                    "queryVector": queryVector,
                    "numCandidates": 100,    // How many to check (higher = slower but more accurate)
                    "limit": 10              // Return top 10 matches
                }
            },
            {
                // Only show dumps belonging to this user or groups they are in
                "$match": {
                    "$or": [
                        { "user": new mongoose.Types.ObjectId(req.user.id) },
                        { "group": { "$in": groupIds.map(id => new mongoose.Types.ObjectId(id)) }, "isPrivate": false }
                    ]
                }
            },
            {
                "$project": {
                    "embedding": 0, // Don't send the massive vector back to frontend
                    "score": { "$meta": "vectorSearchScore" } // Show match confidence score
                }
            }
        ]);

        // 3. Fallback to Text Search if no semantic matches are found
        if (dumps.length === 0) {
            const fallbackDumps = await Dump.find(
                {
                    $text: { $search: query },
                    $or: [
                        { user: req.user.id },
                        { group: { $in: groupIds }, isPrivate: false }
                    ]
                },
                { score: { $meta: "textScore" } }
            )
                .sort({ score: { $meta: "textScore" } })
                .limit(5);

            dumps = fallbackDumps.map(doc => {
                const obj = sanitizeDump(doc);
                obj.isFallback = true;
                return obj;
            });
        }
        res.json(dumps.map(sanitizeDump));

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/dumps/group/:groupId
// @desc    Get all PUBLIC dumps for a specific Hive (Feed)
router.get('/group/:groupId', auth, async (req, res) => {
    if (!req.params) {
        return res.status(400).json({ msg: 'No Hive ID provided' });
    }
    try {
        const { groupId } = req.params;

        if (!groupId || typeof groupId !== 'string') {
            return res.status(400).json({ msg: "Invalid Hive ID" });
        }

        // 1. Security Check: Is the user a member of this group?
        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: "Hive not found" });
        }

        // Convert ObjectIDs to strings for comparison
        const isMember = group.members.some(memberId => memberId.toString() === req.user.id);

        if (!isMember) {
            return res.status(403).json({ msg: "Access Denied: You are not a member of this Hive" });
        }

        // 2. Fetch Dumps
        // Logic: Show PUBLIC dumps from everyone in this group
        //        + PRIVATE dumps that belong to the requesting user (owner can always see their own)
        const dumps = await Dump.find({
            group: groupId,
            $or: [
                { isPrivate: false },                    // All public dumps
                { isPrivate: true, user: req.user.id }   // My own private dumps
            ]
        })
            .populate('user', 'username') // "Populate" fetches the author's name from User collection
            .sort({ createdAt: -1 }); // Newest first

        res.json(dumps.map(sanitizeDump));

    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: "Hive not found" });
        }
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/dumps/:id
// @desc    Get a single dump by ID (for Editing)
router.get('/:id', auth, async (req, res) => {
    try {
        const dump = await Dump.findById(req.params.id);

        if (!dump) {
            return res.status(404).json({ msg: 'Dump not found' });
        }

        // Security Check: Ensure the user owns this dump
        // (Since this is for editing, we are strict about ownership)
        if (dump.user.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Access Denied: You do not own this dump' });
        }

        res.json(sanitizeDump(dump));
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Dump not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/dumps/:id
// @desc    Delete a dump
router.delete('/:id', auth, async (req, res) => {
    if (!req.params || !req.params.id || typeof req.params.id !== 'string') {
        return res.status(400).json({ msg: 'No Dump ID provided or invalid ID format' });
    }
    try {
        const dump = await Dump.findById(req.params.id);

        if (!dump) {
            return res.status(404).json({ msg: 'Dump not found' });
        }

        // Check user ownership
        if (dump.user.toString() !== req.user.id) {
            return res.status(401).json({ msg: 'User not authorized' });
        }

        await dump.deleteOne();

        res.json({ msg: 'Dump removed' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/dumps/:id
// @desc    Update a dump (Content, Privacy, Group)
router.put('/:id', auth, async (req, res) => {
    try {
        const { content, isPrivate, tags } = req.body;
        let { title } = req.body;
        if (content && content.length > 16000) {
            return res.status(400).json({ msg: 'Content too long. Max 16,000 characters allowed.' });
        }
        if (content && content.trim().length === 0) {
            return res.status(400).json({ msg: 'Content cannot be empty' });
        }
        if (content && typeof content !== 'string') {
            return res.status(400).json({ msg: 'Content must be a string' });
        }
        if (tags && !Array.isArray(tags)) {
            console.log("Invalid tags format:", typeof tags); // Debug log
            return res.status(400).json({ msg: 'Tags must be an array' });
        }
        if (tags && tags.length > 10) {
            return res.status(400).json({ msg: 'Too many tags. Max 10 allowed.' });
        }
        if (title && typeof title !== 'string') {
            return res.status(400).json({ msg: 'Title must be a string' });
        }
        if (title && title.length > 100) {
            return res.status(400).json({ msg: 'Title too long. Max 100 characters allowed.' });
        }
        if (title && title.trim().length === 0) {
            title = undefined;
        }
        if (typeof isPrivate !== 'undefined' && typeof isPrivate !== 'boolean') {
            return res.status(400).json({ msg: 'isPrivate must be a boolean' });
        }
        let dump = await Dump.findById(req.params.id);

        if (!dump) {
            return res.status(404).json({ msg: 'Dump not found' });
        }

        // Check user ownership
        if (dump.user.toString() !== req.user.id) {
            return res.status(401).json({ msg: 'User not authorized' });
        }

        // --- THE CRITICAL AI PART ---
        // If content changed, we MUST re-generate the embedding!
        // Otherwise, the search index will point to the old text.
        if (content && content !== dump.content) {
            const contentToEmbed = content.substring(0, 8000);

            const result = await genAI.models.embedContent({
                model: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2-preview',
                contents: [{ parts: [{ text: contentToEmbed }] }],
                config: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 }
            });

            dump.embedding = result.embeddings[0].values;
            dump.content = content; // Update text
        }

        // Update other fields if provided
        if (typeof isPrivate !== 'undefined') dump.isPrivate = isPrivate;
        if (tags) dump.tags = tags;
        if (title) dump.title = title;
        await dump.save();
        res.json(dump);

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});
module.exports = router;