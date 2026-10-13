import mongoose from 'mongoose';

const shlokaSchema = new mongoose.Schema({
  chapterNumber: {
    type: Number,
    required: true,
    min: 1,
    max: 18
  },
  chapterName: {
    type: String,
    required: true,
    trim: true
  },
  section: {
    type: String,
    required: true,
    trim: true
  },
  shlokaNumber: {
    type: String,
    required: true,
    trim: true
  },
  shlokaIndex: {
    type: String,
    trim: true
  },
  sanskritShloka: {
    type: String,
    required: true,
    trim: true
  },
  hindiMeaning: {
    type: String,
    required: true,
    trim: true
  },
  englishMeaning: {
    type: String,
    required: true,
    trim: true
  },
  sanskritTransliteration: {
    type: String,
    trim: true,
    default: ''
  },
  explanation: {
    type: String,
    trim: true,
    default: ''
  },
  audioUrl: {
    type: String,
    default: ''
  },
  tags: {
    type: String,
    trim: true,
    default: ''
  },
  status: {
    type: String,
    enum: ['draft', 'published'],
    default: 'draft'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  clientId: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Helper function to generate shloka index
const generateShlokaIndex = (chapterNumber, shlokaNumber) => {
  const chapterStr = chapterNumber.toString().padStart(2, '0');
  let shlokaStr;
  
  if (shlokaNumber.includes('.')) {
    // Handle dot notation like "1.1", "00.2"
    const afterDot = shlokaNumber.split('.')[1];
    shlokaStr = afterDot ? afterDot.padStart(3, '0') : '001';
  } else {
    // Handle direct numbers like "1", "47"
    shlokaStr = shlokaNumber.padStart(3, '0');
  }
  
  return `BG-${chapterStr}-${shlokaStr}`;
};

// Pre-save middleware to auto-generate shlokaIndex
shlokaSchema.pre('save', function(next) {
  if (this.chapterNumber && this.shlokaNumber) {
    this.shlokaIndex = generateShlokaIndex(this.chapterNumber, this.shlokaNumber);
  }
  next();
});

// Compound index for unique shloka per chapter per client
shlokaSchema.index({ chapterNumber: 1, shlokaNumber: 1, clientId: 1 }, { unique: true });

const Shloka = mongoose.model('Shloka', shlokaSchema);

export default Shloka;