const mongoose = require('mongoose');

const dumpSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    default: null
  },
  // --- NEW FIELD ---
  title: {
    type: String,
    trim: true,
    maxlength: 100, // Short and sweet
    default: function() {
      // Smart Default: If no title is provided, use the first 30 chars of content...
      if (this.content && this.content.length > 0) {
        return this.content.substring(0, 30) + (this.content.length > 30 ? "..." : "");
      }
      return "Untitled Dump";
    }
  },
  // -----------------
  content: {
    type: String,
    required: true
    // No maxlength here, allowing for very large text (up to 16MB MongoDB limit)
  },
  embedding: {
    type: [Number], 
    required: true
    // This allows the AI search to work.
  },
  tags: [String], 
  isPrivate: {
    type: Boolean,
    default: true
  },
  lastEditedAt: {
    type: Date
    // Useful if users keep "adding onto" a dump
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create a text index for standard keyword search (backup for Vector search)
dumpSchema.index({ title: 'text', content: 'text' });

module.exports = mongoose.model('Dump', dumpSchema);