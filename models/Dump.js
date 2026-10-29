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
  title: {
    type: String,
    trim: true,
    maxlength: 100, 
    default: function() {
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
  },
  embedding: {//Vector embedding for semantic search
    type: [Number], 
    required: true
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


dumpSchema.index({ title: 'text', content: 'text' });
dumpSchema.index({ user: 1, createdAt: -1 });
dumpSchema.index({ group: 1, isPrivate: 1, createdAt: -1 });

module.exports = mongoose.model('Dump', dumpSchema);