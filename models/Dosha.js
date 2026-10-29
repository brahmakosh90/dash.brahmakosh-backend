// src/models/Dosha.js
import mongoose from 'mongoose';

const doshaSchema = new mongoose.Schema(
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
    // Normalized dosha results (manglik, kalsarpa, sadeSatiCurrent, sadeSatiLife, pitra, etc.)
    doshas: mongoose.Schema.Types.Mixed,
    // Dasha data (current_yogini_dasha, current_chardasha, major_chardasha, etc.)
    dashas: mongoose.Schema.Types.Mixed,
    // Summary flags and any derived info
    summary: mongoose.Schema.Types.Mixed,
    lastFetched: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

// userId index is already created by unique:true on the field definition.

const Dosha = mongoose.model('Dosha', doshaSchema);

export default Dosha;
