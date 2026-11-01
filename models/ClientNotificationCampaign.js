import mongoose from 'mongoose';

const clientNotificationCampaignSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientNotificationGroup',
      default: null
    },
    userIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    ],
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      required: true,
      trim: true
    },
    url: {
      type: String,
      trim: true,
      default: ''
    },
    postType: {
      type: String,
      enum: ['immediate', 'scheduled'],
      default: 'immediate'
    },
    scheduledFor: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: ['scheduled', 'sending', 'sent', 'failed'],
      default: 'scheduled'
    },
    sentAt: {
      type: Date,
      default: null
    },
    totalRecipients: {
      type: Number,
      default: 0
    },
    // Token counts (multi-device): how many device tokens were attempted.
    totalTokens: {
      type: Number,
      default: 0
    },
    sentCount: {
      type: Number,
      default: 0
    },
    failedCount: {
      type: Number,
      default: 0
    },
    errorMessage: {
      type: String,
      trim: true,
      default: ''
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true
    }
  },
  { timestamps: true }
);

clientNotificationCampaignSchema.index({ clientId: 1, createdAt: -1 });
clientNotificationCampaignSchema.index({ status: 1, scheduledFor: 1 });

export default mongoose.model('ClientNotificationCampaign', clientNotificationCampaignSchema);
