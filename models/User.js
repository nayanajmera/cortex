const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name : {type: String, maxlength: 50},
  username: {
    type: String,
    required: true,
    unique: true, // Crucial for your contact search feature
    trim: true,
    minlength: 3
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  // Who does this user know? (For the Contacts Page)
  contacts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  profilePic: {
    type: String,
    default: "" // URL to image
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', userSchema);