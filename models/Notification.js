import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['daily_reminder', 'streak_alert', 'completion', 'milestone', 'client_broadcast'],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  data: {
    userSankalpId: mongoose.Schema.Types.ObjectId,
    sankalpId: mongoose.Schema.Types.ObjectId,
    streak: Number,
    karmaEarned: Number,
    // client broadcast payload (without these the link/campaign were silently dropped on save)
    url: String,
    campaignId: String,
    groupId: String,
    clientId: String
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  sentAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
