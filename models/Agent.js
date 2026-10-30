import mongoose from 'mongoose';

/**
 * Agent Model
 * Client-configurable AI agent presets used by mobile/web.
 * Controls the voice slot (VoiceConfig) + system prompt for Ask AI flows.
 */
const agentSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    voiceName: {
      type: String,
      required: true,
      trim: true,
      enum: [
        'krishna1', 'krishna2', 'krishna3',
        'rashmi1', 'rashmi2', 'rashmi3',
        'saavi1', 'kanika1', 'roohi1', 'kanika2',
        'ranbir1', 'priyanka1', 'god1', 'raqib1',
        'rasmi1'
      ],
    },
    systemPrompt: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
    firstMessage: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdByRole: {
      type: String,
      default: 'client',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
    },
  },
  { timestamps: true }
);

agentSchema.index({ clientId: 1, name: 1 }, { unique: true });

const Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);
export default Agent;

