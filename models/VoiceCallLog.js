import mongoose from 'mongoose';

const voiceCallLogSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, index: true, unique: true },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner', required: true },

    status: {
      type: String,
      enum: ['ringing', 'in_call', 'rejected', 'ended', 'busy', 'missed'],
      default: 'ringing',
      index: true
    },

    initiatedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      type: { type: String, enum: ['user', 'partner'], required: true }
    },

    from: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      type: { type: String, enum: ['user', 'partner'], required: true },
      name: { type: String, default: null },
      email: { type: String, default: null }
    },
    to: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      type: { type: String, enum: ['user', 'partner'], required: true },
      name: { type: String, default: null },
      email: { type: String, default: null }
    },

    initiatedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },

    endedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      type: { type: String, enum: ['user', 'partner', null], default: null }
    },
    rejectedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      type: { type: String, enum: ['user', 'partner', null], default: null }
    },

    durationSeconds: { type: Number, default: 0, min: 0 },
    billableMinutes: { type: Number, default: 0, min: 0 }
  },
  { timestamps: true }
);

voiceCallLogSchema.index({ userId: 1, createdAt: -1 });
voiceCallLogSchema.index({ partnerId: 1, createdAt: -1 });

export default mongoose.model('VoiceCallLog', voiceCallLogSchema);

