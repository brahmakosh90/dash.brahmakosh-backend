// src/models/Remedy.js
import mongoose from 'mongoose';

const remedySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true
    },
    birthData: {
      day: Number,
      month: Number,
      year: Number,
      hour: Number,
      min: Number,
      lat: Number,
      lon: Number,
      tzone: Number
    },
    remedies: {
      puja: mongoose.Schema.Types.Mixed,
      gemstone: mongoose.Schema.Types.Mixed,
      rudraksha: mongoose.Schema.Types.Mixed
    },
    lastFetched: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

// userId index is already created by unique:true on the field definition.

const Remedy = mongoose.model('Remedy', remedySchema);

export default Remedy;

