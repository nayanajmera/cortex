const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Group = require('../models/Group');
const crypto = require('crypto'); 

// @route   POST /api/groups
// @desc    Create a new Hive
router.post('/', auth, async (req, res) => {
    if(!req.body){
        return res.status(400).json({ msg: "No data provided" });
    }
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ msg: "Name is required" });
        if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
            return res.status(400).json({ msg: "Hive name must be between 1 and 100 characters." });
        }

        let joinCode;
        let isUnique = false;

        while (!isUnique) {
            joinCode = crypto.randomBytes(3).toString('hex').toUpperCase(); 
            
            // Check database to see if this code already exists
            const existingGroup = await Group.findOne({ joinCode });
            if (!existingGroup) {
                isUnique = true; 
            }
        }

        const newGroup = new Group({
            name,
            joinCode, // Guaranteed unique now
            creator: req.user.id,
            members: [req.user.id]
        });

        const group = await newGroup.save();
        res.json(group);

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/groups/join
// @desc    Join a Hive using a Code
router.post('/join', auth, async (req, res) => {
    if(!req.body){
        return res.status(400).json({ msg: "No data provided" });
    }
    try {
        const { joinCode } = req.body;
        if (!joinCode) return res.status(400).json({ msg: "Join Code is required" });

        // 1. Find the group
        const group = await Group.findOne({ joinCode });
        if (!group) {
            return res.status(404).json({ msg: "Invalid Hive Code" });
        }

        // 2. Check if already a member
        if (group.members.includes(req.user.id)) {
            return res.status(400).json({ msg: "You are already in this Hive" });
        }

        // 3. Add user to members array
        group.members.push(req.user.id);
        await group.save();

        const updatedGroup = await Group.findById(group._id).populate('members', 'username name');
        const io = req.app.get('io');
        if (io) {
            io.to(group._id.toString()).emit('hive_membership_updated', { group: updatedGroup });
        }

        res.json(updatedGroup);

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/groups
// @desc    Get all Hives the user is part of
router.get('/', auth, async (req, res) => {
    try {
        // Find groups where the 'members' array contains the User's ID
        const groups = await Group.find({ members: req.user.id })
            .populate('members', 'username name')
            .sort({ createdAt: -1 });
        
        res.json(groups);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


// @route   PUT /api/groups/:id
// @desc    Rename Group (Admin Only)
router.put('/:id', auth, async (req, res) => {
    try {
        const { name } = req.body;
        const group = await Group.findById(req.params.id);

        if (!group) return res.status(404).json({ msg: "Hive not found" });
        if (group.creator.toString() !== req.user.id) {
            return res.status(401).json({ msg: "Not authorized" });
        }

        group.name = name;
        await group.save();
        res.json(group);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/groups/:id/members/:userId
// @desc    Remove a member (Admin Only)
router.delete('/:id/members/:userId', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        const Dump = require('../models/Dump');

        if (!group) return res.status(404).json({ msg: "Hive not found" });
        if (group.creator.toString() !== req.user.id) {
            return res.status(401).json({ msg: "Not authorized" });
        }

        // Filter out the member
        group.members = group.members.filter(
            member => member.toString() !== req.params.userId
        );
        
        await group.save();
        
        // Detach all dumps belonging to the kicked member
        await Dump.updateMany(
            { group: req.params.id, user: req.params.userId },
            { 
                $unset: { group: 1 },
                $set: { isPrivate: true }
            }
        );

        const revokeHiveAccessForUser = req.app.get('revokeHiveAccessForUser');
        if (revokeHiveAccessForUser) {
            revokeHiveAccessForUser(req.params.userId, req.params.id);
        }

        const updatedGroup = await Group.findById(req.params.id).populate('members', 'username name');
        const io = req.app.get('io');
        if (io) {
            io.to(req.params.id).emit('hive_membership_updated', { group: updatedGroup });
        }

        res.json(updatedGroup);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/groups/:id/leave
// @desc    Leave a Hive (Members Only)
router.delete('/:id/leave', auth, async (req, res) => {
    try {
        const group = await Group.findById(req.params.id);
        const Dump = require('../models/Dump');

        if (!group) return res.status(404).json({ msg: "Hive not found" });
        
        // Creator cannot leave, must delete
        if (group.creator.toString() === req.user.id) {
            return res.status(400).json({ msg: "Creator cannot leave the hive. You must delete it." });
        }

        // Check if user is actually in the group
        if (!group.members.includes(req.user.id)) {
            return res.status(400).json({ msg: "You are not a member of this hive" });
        }

        // Filter out the user
        group.members = group.members.filter(
            member => member.toString() !== req.user.id
        );
        
        await group.save();

        const revokeHiveAccessForUser = req.app.get('revokeHiveAccessForUser');
        if (revokeHiveAccessForUser) {
            revokeHiveAccessForUser(req.user.id, req.params.id);
        }
        
        // Detach all dumps belonging to the leaving member
        await Dump.updateMany(
            { group: req.params.id, user: req.user.id },
            { 
                $unset: { group: 1 },
                $set: { isPrivate: true }
            }
        );

        const updatedGroup = await Group.findById(req.params.id).populate('members', 'username name');
        const io = req.app.get('io');
        if (io) {
            io.to(req.params.id).emit('hive_membership_updated', { group: updatedGroup });
        }

        res.json({ msg: "Successfully left the hive" });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


// @route   DELETE /api/groups/:id
// @desc    Delete Group (Safely handle user data)
router.delete('/:id', auth, async (req, res) => {
    try {
        const { keepDumps } = req.query; // 'true' or 'false'
        const Dump = require('../models/Dump'); // Import locally to ensure access

        const group = await Group.findById(req.params.id);

        if (!group) return res.status(404).json({ msg: "Hive not found" });
        
        // Security: Only Creator can delete
        if (group.creator.toString() !== req.user.id) {
            return res.status(401).json({ msg: "Not authorized" });
        }

        if (keepDumps !== 'true') {
            // If Admin said "Delete my notes", we delete ONLY the Admin's notes from this group.
            await Dump.deleteMany({ group: req.params.id, user: req.user.id });
        }
        // (If keepDumps === 'true', we do nothing here; they get caught in Step 2)

        await Dump.updateMany(
            { group: req.params.id },
            { 
                $unset: { group: 1 },        // Remove the Group ID (Unlink)
                $set: { isPrivate: true },   // Make it Private
            }
        );

        await group.deleteOne();

        const io = req.app.get('io');
        if (io) {
            io.to(req.params.id).emit('hive_deleted', { hiveId: req.params.id });
        }

        res.json({ msg: "Hive deleted successfully." });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


module.exports = router;