const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Group = require('../models/Group');
const Dump = require('../models/Dump');
const auth = require('../middleware/auth');
router.get('/', auth, async (req, res) => {
    try {
        // Get user from DB, but EXCLUDE the password (-password)
        const user = await User.findById(req.user.id).select('-password');
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', async (req, res) => {
    if(!req.body){
        return res.status(400).json({ msg: 'No data provided' });
    }
    const { name, username, email, password } = req.body;
    if(!name || !username || !email || !password){
        return res.status(400).json({ msg: 'Please enter all fields' });
    }
    if(name.length > 50 || username.length < 3 || username.length > 30 || password.length < 6 || email.length > 100){
        return res.status(400).json({ msg: 'Invalid input data' });
    }
    try {
        // 1. Check if user already exists
        let user = await User.findOne({ email });
        if (user) {
            return res.status(400).json({ msg: 'User already exists' });
        }
        user = await User.findOne({ username });
        if(user){
            return res.status(400).json({ msg: 'username is taken' });
        }
        // 2. Create new user instance
        user = new User({
            name,
            username,
            email,
            password
        });

        // 3. Hash the password (Security)
        user.password = await bcrypt.hash(password, 10);

        // 4. Save to Database
        await user.save();

        // 5. Generate a Token (JWT) so they are logged in immediately
        const payload = {
            user: {
                id: user.id
            }
        };

        jwt.sign(
            payload,
            process.env.JWT_SECRET, // We need to add this to .env
            { expiresIn: '5d' }, // Token lasts 5 days
            (err, token) => {
                if (err) throw err;
                res.status(200).json({ token });
            }
        );

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', async (req, res) => {
    if(!req.body){
        return res.status(400).json({ msg: 'No data provided' });
    }
    const { email, password } = req.body;

    try {
        // 1. Check if user exists
        let user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        // 2. Compare Password (Plain text vs Hash)
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        // 3. Generate Token
        const payload = {
            user: {
                id: user.id
            }
        };

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: '5d' },
            (err, token) => {
                if (err) throw err;
                res.json({ token });
            }
        );

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   GET /api/users/stats
// @desc    Get user dashboard stats
router.get('/stats', auth, async (req, res) => {
    try {
        // Run these in parallel for speed
        const [dumpCount, groupCount] = await Promise.all([
            Dump.countDocuments({ user: req.user.id }),
            Group.countDocuments({ members: req.user.id })
        ]);

        res.json({ dumps: dumpCount, hives: groupCount });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/auth/profile
// @desc    Update User Profile (Name, Username, Password ONLY)
router.put('/profile', auth, async (req, res) => {
    if(!req.body){
        return res.status(400).json({ msg: 'No data provided' });
    }
    try {
        const { name, username, password } = req.body; // <--- No email here
        const userId = req.user.id;
        if((name && name.length > 50) || (username && (username.length < 3 || username.length > 30)) || (password && password.length < 6)){
            return res.status(400).json({ msg: 'Invalid input data. Please enter reasonable values.' });
        }
        // 1. Validation: Check if the NEW username is taken by SOMEONE ELSE
        if (username) {
            const usernameExists = await User.findOne({ 
                username: username, 
                _id: { $ne: userId }
            });
            if (usernameExists) {
                return res.status(400).json({ msg: "This username is already taken." });
            }
        }

        // 2. Find User
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: "User not found" });

        // 3. Update Fields (Ignored Email)
        if (name) user.name = name;
        if (username) user.username = username;
        
        // 4. Password Update (Optional)
        if (password && password.length >= 6) {
            const bcrypt = require('bcryptjs');
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(password, salt);
        }

        await user.save();

        const updatedUser = await User.findById(userId).select('-password');
        res.json(updatedUser);

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});
module.exports = router;