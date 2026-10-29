import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true
  },
  content: {
    type: String,
    required: true
  },
  /** Storage key for stored audio (user speech or AI TTS). Use getPresignedUrl(key) from utils/storage.js for presigned playback URL. */
  audioKey: {
    type: String,
    default: null,
    trim: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const chatSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    default: 'New Chat'
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    default: null,
    index: true
  },
  liveAvatarId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LiveAvatar',
    default: null,
    index: true
  },
  avatarName: {
    type: String,
    default: null,
    trim: true
  },
  voiceStartTime: {
    type: Date,
    default: null
  },
  voiceEndTime: {
    type: Date,
    default: null
  },
  messages: [messageSchema],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for faster queries
chatSchema.index({ userId: 1, createdAt: -1 });
chatSchema.index({ userId: 1, updatedAt: -1 });

// Update updatedAt before saving
chatSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const Chat = mongoose.model('Chat', chatSchema);

export default Chat;

