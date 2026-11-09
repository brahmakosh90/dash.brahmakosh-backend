import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import Meditation from '../models/Meditation.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/auth.js';
import { uploadFile, deleteFile, generateUploadUrl, getPresignedUrl, extractS3KeyFromUrl } from '../utils/storage.js';
import { withSignedMedia, isOwnStorageUrl } from '../utils/mediaUrls.js';
import { normalizeCategory, normalizeInstructions } from '../utils/meditationContent.js';

const router = express.Router();

// Configure multer for file upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024 // 200MB limit (supports ~5 min HD video)
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video') {
      if (file.mimetype.startsWith('video/')) {
        cb(null, true);
      } else {
        cb(new Error('Only video files are allowed for video field'), false);
      }
    } else if (file.fieldname === 'image') {
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed for image field'), false);
      }
    } else {
      cb(new Error('Unexpected field'), false);
    }
  }
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
  console.log('=== MULTER ERROR HANDLER ===');
  console.log('Error type:', err.constructor.name);
  console.log('Error message:', err.message);
  console.log('Error code:', err.code);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 200MB'
      });
    }
  }
  if (err.message.includes('Only') && err.message.includes('files are allowed')) {
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
  next(err);
};

// Helper functions
const resolveClientObjectId = async (candidate) => {
  if (!candidate) return null;
  if (mongoose.Types.ObjectId.isValid(candidate)) return candidate;
  const client = await Client.findOne({ clientId: candidate }).select('_id');
  return client?._id || null;
};

const withClientIdString = (doc) => {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : doc;
  
  // If clientId is populated with Client document
  if (obj.clientId && typeof obj.clientId === 'object') {
    // Extract clientId string field (CLI-ABC123 format)
    if (obj.clientId.clientId) {
      return { ...obj, clientId: obj.clientId.clientId };
    }
    // Fallback: If clientId field missing in Client document
    console.warn('Client document missing clientId field:', obj.clientId._id);
    return { ...obj, clientId: null };
  }
  
  return obj;
};

const getClientId = async (req) => {
  if (req.user.role === 'user') {
    const rawClientId = req.decodedClientId || req.user.clientId?._id || req.user.clientId || req.user.tokenClientId || req.user.clientId?.clientId;
    const clientId = await resolveClientObjectId(rawClientId);
    if (!clientId) {
      throw new Error('Client ID not found for user token. Please ensure your token includes clientId.');
    }
    return clientId;
  }
  
  // For client role, their _id IS the clientId (no need to resolve)
  if (req.user.role === 'client') {
    const clientId = req.user._id || req.user.id;
    if (!clientId) {
      throw new Error('Client ID not found. Please login again.');
    }
    return clientId; // Return the ObjectId directly
  }
  
  // Wrong kind of account (e.g. an admin token), not a failed login: 403, so the app doesn't treat it as an expired session
  const roleError = new Error('This endpoint is only available to client and user accounts.');
  roleError.status = 403;
  throw roleError;
};

// POST /api/meditations/upload-url - Generate presigned URL for direct S3 upload
router.post('/upload-url', authenticate, async (req, res) => {
  try {
    const { fileName, contentType, fileType } = req.body;
    
    if (!fileName || !contentType) {
      return res.status(400).json({
        success: false,
        message: 'fileName and contentType are required'
      });
    }
    
    const folder = fileType === 'video' ? 'meditations/videos' : fileType === 'audio' ? 'meditations/audio' : 'meditations/images';
    const { uploadUrl, fileUrl, key } = await generateUploadUrl(fileName, contentType, folder);
    
    res.json({
      success: true,
      data: { uploadUrl, fileUrl, key }
    });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate upload URL',
      error: error.message
    });
  }
});

// POST /api/meditations/direct - Create meditation with direct S3 URLs
router.post('/direct', authenticate, async (req, res) => {
  try {
    const { name, description, link, videoUrl, imageUrl, videoKey: vKey, imageKey: iKey, audioUrl, audioKey: aKey, category, instructions } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }
    
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }
    
    if (!description || description.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Description is required'
      });
    }
    
    const meditationData = {
      name: name.trim(),
      description: description.trim(),
      link: link ? link.trim() : '',
      clientId: clientId,
      videoUrl: videoUrl || undefined,
      videoKey: vKey || (videoUrl ? extractS3KeyFromUrl(videoUrl) : undefined),
      imageUrl: imageUrl || undefined,
      imageKey: iKey || (imageUrl ? extractS3KeyFromUrl(imageUrl) : undefined),
      audioUrl: audioUrl || undefined,
      audioKey: aKey || (audioUrl ? extractS3KeyFromUrl(audioUrl) : undefined),
      category: normalizeCategory(category),
      instructions: normalizeInstructions(instructions)
    };
    
    const meditation = new Meditation(meditationData);
    await meditation.save();
    
    const meditationObj = withClientIdString(await meditation.populate('clientId', 'clientId'));
    if (meditationObj.videoKey) { try { meditationObj.videoUrl = await getPresignedUrl(meditationObj.videoKey); } catch(e) {} }
    if (meditationObj.imageKey) { try { meditationObj.imageUrl = await getPresignedUrl(meditationObj.imageKey); } catch(e) {} }
    if (meditationObj.audioKey) { try { meditationObj.audioUrl = await getPresignedUrl(meditationObj.audioKey); } catch(e) {} }
    res.status(201).json({ success: true, message: 'Meditation created successfully', data: meditationObj });
  } catch (error) {
    console.error('Error creating meditation:', error);
    res.status(500).json({ success: false, message: 'Failed to create meditation', error: error.message });
  }
});

// GET /api/meditations - Get all meditations for authenticated client
router.get('/', authenticate, async (req, res) => {
  try {
    console.log('=== MEDITATION GET REQUEST START ===');
    console.log('User info:', {
      id: req.user?._id?.toString(),
      role: req.user?.role,
      email: req.user?.email
    });
    
    let clientId;
    try {
      clientId = await getClientId(req);
      console.log('Resolved client ID for query:', clientId?.toString());
    } catch (clientIdError) {
      if (!clientIdError.status) console.error('Client ID resolution error in GET:', clientIdError);
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    const query = { clientId: clientId };
    // Don't filter by isActive - show all meditations
    console.log('MongoDB query:', query);

    const meditations = await Meditation.find(query)
      .populate('clientId', 'clientId')
      .sort({ createdAt: -1 });
    
    console.log('Found meditations:', meditations.length);
    console.log('Meditation details:', meditations.map(m => ({
      id: m._id.toString(),
      name: m.name,
      hasVideo: !!m.videoUrl,
      hasImage: !!m.imageUrl,
      clientId: m.clientId?.toString()
    })));

    const meditationsWithUrls = await Promise.all(
      meditations.map(async (meditation) => {
        const meditationObj = withClientIdString(meditation);
        
        // Generate presigned URL for video if exists
        if (meditationObj.videoKey || meditationObj.videoUrl) {
          try {
            // Use stored key if available, otherwise extract from URL
            const videoKey = meditationObj.videoKey || extractS3KeyFromUrl(meditationObj.videoUrl);
            if (videoKey) {
              meditationObj.videoUrl = await getPresignedUrl(videoKey);
            }
          } catch (error) {
            console.error('Error generating video presigned URL:', error);
          }
        }
        
        // Generate presigned URL for image if exists
        if (meditationObj.imageKey || meditationObj.imageUrl) {
          try {
            // Use stored key if available, otherwise extract from URL
            const imageKey = meditationObj.imageKey || extractS3KeyFromUrl(meditationObj.imageUrl);
            if (imageKey) {
              meditationObj.imageUrl = await getPresignedUrl(imageKey);
            }
          } catch (error) {
            console.error('Error generating image presigned URL:', error);
          }
        }
        
        if (meditationObj.audioKey || meditationObj.audioUrl) {
          try {
            const audioKey = meditationObj.audioKey || (isOwnStorageUrl(meditationObj.audioUrl) ? extractS3KeyFromUrl(meditationObj.audioUrl) : null);
            if (audioKey) meditationObj.audioUrl = await getPresignedUrl(audioKey);
          } catch (error) {
            console.error('Error generating audio presigned URL:', error);
          }
        }

        meditationObj.category = normalizeCategory(meditationObj.category);
        return meditationObj;
      })
    );

    res.json({
      success: true,
      data: meditationsWithUrls,
      count: meditationsWithUrls.length
    });
  } catch (error) {
    console.error('Error fetching meditations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch meditations',
      error: error.message
    });
  }
});

// GET /api/meditations/:id - Get single meditation
router.get('/:id', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    const meditation = await Meditation.findOne({
      _id: req.params.id,
      clientId: clientId,
      isActive: true
    }).populate('clientId', 'clientId');

    if (!meditation) {
      return res.status(404).json({
        success: false,
        message: 'Meditation not found'
      });
    }

    const meditationObj = withClientIdString(meditation);
    
    const vKey = meditationObj.videoKey || extractS3KeyFromUrl(meditationObj.videoUrl);
    if (vKey) { try { meditationObj.videoUrl = await getPresignedUrl(vKey); } catch(e) {} }
    const iKey = meditationObj.imageKey || extractS3KeyFromUrl(meditationObj.imageUrl);
    if (iKey) { try { meditationObj.imageUrl = await getPresignedUrl(iKey); } catch(e) {} }
    const aKey = meditationObj.audioKey || (isOwnStorageUrl(meditationObj.audioUrl) ? extractS3KeyFromUrl(meditationObj.audioUrl) : null);
    if (aKey) { try { meditationObj.audioUrl = await getPresignedUrl(aKey); } catch(e) { console.error('Error generating audio presigned URL:', e); } }
    meditationObj.category = normalizeCategory(meditationObj.category);
    res.json({ success: true, data: meditationObj });
  } catch (error) {
    console.error('Error fetching meditation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch meditation',
      error: error.message
    });
  }
});

// POST /api/meditations - Create new meditation
router.post('/', authenticate, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), handleMulterError, async (req, res) => {
  console.log('=== MEDITATION CREATE REQUEST START ===');
  console.log('User info:', {
    id: req.user?._id?.toString(),
    role: req.user?.role,
    email: req.user?.email
  });
  console.log('Request body:', req.body);
  console.log('Request files received:', {
    hasFiles: !!req.files,
    fileKeys: req.files ? Object.keys(req.files) : [],
    videoCount: req.files?.video?.length || 0,
    imageCount: req.files?.image?.length || 0
  });
  
  // CRITICAL: Check if files are actually received
  if (req.files) {
    console.log('Files details:');
    Object.keys(req.files).forEach(fieldName => {
      const files = req.files[fieldName];
      files.forEach((file, index) => {
        console.log(`  ${fieldName}[${index}]:`, {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          hasBuffer: !!file.buffer,
          bufferSize: file.buffer?.length
        });
      });
    });
  } else {
    console.log('❌ NO FILES RECEIVED IN REQUEST');
  }
  
  try {
    const { name, description, link } = req.body;

    // Get client ID with detailed logging
    let clientId;
    try {
      console.log('Getting client ID for user:', {
        userId: req.user._id?.toString(),
        userRole: req.user.role,
        decodedClientId: req.decodedClientId
      });
      
      clientId = await getClientId(req);
      console.log('Final client ID:', clientId?.toString());
    } catch (clientIdError) {
      if (!clientIdError.status) console.error('Client ID resolution error:', clientIdError);
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }

    // Validation
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }
    
    if (!description || description.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Description is required'
      });
    }

    const meditationData = {
      name: name.trim(),
      description: description.trim(),
      link: link ? link.trim() : '',
      clientId: clientId
    };

    // Upload files to S3 with proper error handling
    console.log('=== FILE UPLOAD SECTION ===');
    let uploadedVideoUrl = null;
    let uploadedImageUrl = null;
    
    try {
      if (req.files && req.files.video) {
        console.log('Processing video upload...');
        const videoFile = req.files.video[0];
        console.log('Video file details:', {
          originalname: videoFile.originalname,
          mimetype: videoFile.mimetype,
          size: videoFile.size,
          hasBuffer: !!videoFile.buffer
        });
        
        const videoUploadResult = await uploadFile(videoFile, 'meditations/videos');
        uploadedVideoUrl = videoUploadResult.url || null;
        meditationData.videoUrl = uploadedVideoUrl;
        meditationData.videoKey = videoUploadResult.key;
      } else {
        console.log('No video file provided');
      }

      if (req.files && req.files.image) {
        console.log('Processing image upload...');
        const imageFile = req.files.image[0];
        console.log('Image file details:', {
          originalname: imageFile.originalname,
          mimetype: imageFile.mimetype,
          size: imageFile.size,
          hasBuffer: !!imageFile.buffer
        });
        
        const imageUploadResult = await uploadFile(imageFile, 'meditations/images');
        uploadedImageUrl = imageUploadResult.url || null;
        meditationData.imageUrl = uploadedImageUrl;
        meditationData.imageKey = imageUploadResult.key;
      } else {
        console.log('No image file provided');
      }
    } catch (uploadError) {
      console.error('File upload failed:', uploadError);
      
      // Cleanup any successfully uploaded files
      if (uploadedVideoUrl) {
        try {
          await deleteFile(uploadedVideoUrl);
          console.log('Cleaned up uploaded video after error');
        } catch (cleanupError) {
          console.error('Failed to cleanup video:', cleanupError);
        }
      }
      if (uploadedImageUrl) {
        try {
          await deleteFile(uploadedImageUrl);
          console.log('Cleaned up uploaded image after error');
        } catch (cleanupError) {
          console.error('Failed to cleanup image:', cleanupError);
        }
      }
      
      return res.status(400).json({
        success: false,
        message: 'File upload failed: ' + uploadError.message
      });
    }
    
    console.log('=== CREATING MEDITATION IN DATABASE ===');
    console.log('Final meditation data:', {
      name: meditationData.name,
      description: meditationData.description,
      link: meditationData.link,
      clientId: meditationData.clientId?.toString(),
      hasVideoUrl: !!meditationData.videoUrl,
      hasImageUrl: !!meditationData.imageUrl,
      videoUrl: meditationData.videoUrl,
      imageUrl: meditationData.imageUrl
    });
    
    const meditation = new Meditation(meditationData);
    await meditation.save();
    console.log('Meditation saved successfully with ID:', meditation._id.toString());

    const createdObj = withClientIdString(await meditation.populate('clientId', 'clientId'));
    if (createdObj.videoKey) { try { createdObj.videoUrl = await getPresignedUrl(createdObj.videoKey); } catch(e) {} }
    if (createdObj.imageKey) { try { createdObj.imageUrl = await getPresignedUrl(createdObj.imageKey); } catch(e) {} }
    res.status(201).json({ success: true, message: 'Meditation created successfully', data: createdObj });
    
  } catch (error) {
    console.error('=== MEDITATION CREATE ERROR ===');
    console.error('Error:', error.message);
    
    res.status(500).json({
      success: false,
      message: 'Failed to create meditation',
      error: error.message
    });
  }
});

// PUT /api/meditations/:id/direct - Update meditation with direct S3 URLs
router.put('/:id/direct', authenticate, async (req, res) => {
  try {
    const { name, description, link, videoUrl, imageUrl, videoKey: vKey, imageKey: iKey, audioUrl, audioKey: aKey, category, instructions } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }
    
    const meditation = await Meditation.findOne({
      _id: req.params.id,
      clientId: clientId,
      isActive: true
    });
    
    if (!meditation) {
      return res.status(404).json({
        success: false,
        message: 'Meditation not found'
      });
    }
    
    if (name) meditation.name = name.trim();
    if (description) meditation.description = description.trim();
    if (link !== undefined) meditation.link = link.trim();
    if (category !== undefined) meditation.category = normalizeCategory(category);
    if (instructions !== undefined) meditation.instructions = normalizeInstructions(instructions);

    // Update audio track if provided
    if (audioUrl || aKey) {
      const oldAudio = meditation.audioKey || meditation.audioUrl;
      const newAudioKey = aKey || (audioUrl ? extractS3KeyFromUrl(audioUrl) : null);
      if (oldAudio && newAudioKey && oldAudio !== newAudioKey) {
        try { await deleteFile(oldAudio); } catch (error) { console.error('Failed to delete old audio:', error); }
      }
      meditation.audioUrl = audioUrl || null;
      meditation.audioKey = newAudioKey;
    }
    
    // Update video URL if provided
    if (videoUrl || vKey) {
      if (videoUrl && meditation.videoUrl && meditation.videoUrl !== videoUrl) {
        try {
          if (meditation.videoKey) {
            await deleteFile(meditation.videoKey);
          } else {
            await deleteFile(meditation.videoUrl);
          }
        } catch (error) {
          console.error('Failed to delete old video:', error);
        }
      }
      meditation.videoUrl = videoUrl || null;
      meditation.videoKey = vKey || (videoUrl ? extractS3KeyFromUrl(videoUrl) : null);
    }
    
    // Update image URL if provided
    if (imageUrl || iKey) {
      if (imageUrl && meditation.imageUrl && meditation.imageUrl !== imageUrl) {
        try {
          await deleteFile(meditation.imageKey || meditation.imageUrl);
        } catch (error) {
          console.error('Failed to delete old image:', error);
        }
      }
      meditation.imageUrl = imageUrl || null;
      meditation.imageKey = iKey || (imageUrl ? extractS3KeyFromUrl(imageUrl) : null);
    }
    
    await meditation.save();
    
    const meditationObj = withClientIdString(await meditation.populate('clientId', 'clientId'));
    const vk = meditationObj.videoKey || extractS3KeyFromUrl(meditationObj.videoUrl);
    if (vk) { try { meditationObj.videoUrl = await getPresignedUrl(vk); } catch(e) {} }
    const ik = meditationObj.imageKey || extractS3KeyFromUrl(meditationObj.imageUrl);
    if (ik) { try { meditationObj.imageUrl = await getPresignedUrl(ik); } catch(e) {} }
    const ak = meditationObj.audioKey || (isOwnStorageUrl(meditationObj.audioUrl) ? extractS3KeyFromUrl(meditationObj.audioUrl) : null);
    if (ak) { try { meditationObj.audioUrl = await getPresignedUrl(ak); } catch(e) {} }
    res.json({ success: true, message: 'Meditation updated successfully', data: meditationObj });
  } catch (error) {
    console.error('Error updating meditation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update meditation',
      error: error.message
    });
  }
});

// PUT /api/meditations/:id - Update meditation
router.put('/:id', authenticate, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), handleMulterError, async (req, res) => {
  console.log('=== MEDITATION UPDATE REQUEST START ===');
  console.log('Request body:', req.body);
  console.log('Files:', req.files ? {
    video: req.files.video ? req.files.video[0].originalname : 'No video',
    image: req.files.image ? req.files.image[0].originalname : 'No image'
  } : 'No files');
  
  try {
    const { name, description, link } = req.body;

    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    const meditation = await Meditation.findOne({
      _id: req.params.id,
      clientId: clientId,
      isActive: true
    });

    if (!meditation) {
      return res.status(404).json({
        success: false,
        message: 'Meditation not found'
      });
    }

    // Update basic fields
    if (name) meditation.name = name.trim();
    if (description) meditation.description = description.trim();
    if (link !== undefined) meditation.link = link.trim();

    // Upload new video to S3 if provided
    if (req.files && req.files.video) {
      console.log('Uploading new video to S3...');
      try {
        const videoFile = req.files.video[0];
        const videoUploadResult = await uploadFile(videoFile, 'meditations/videos');
        if (meditation.videoKey || meditation.videoUrl) {
          await deleteFile(meditation.videoKey || meditation.videoUrl);
        }
        meditation.videoUrl = videoUploadResult.url || null;
        meditation.videoKey = videoUploadResult.key;
        console.log('Video updated in S3:', videoUploadResult.key);
      } catch (error) {
        console.error('Video upload failed:', error);
        return res.status(400).json({
          success: false,
          message: 'Video upload failed',
          error: error.message
        });
      }
    }

    // Upload new image to S3 if provided
    if (req.files && req.files.image) {
      console.log('Uploading new image to S3...');
      try {
        const imageFile = req.files.image[0];
        const imageUploadResult = await uploadFile(imageFile, 'meditations/images');
        if (meditation.imageKey || meditation.imageUrl) {
          await deleteFile(meditation.imageKey || meditation.imageUrl);
        }
        meditation.imageUrl = imageUploadResult.url || null;
        meditation.imageKey = imageUploadResult.key;
        console.log('Image updated in S3:', imageUrl);
      } catch (error) {
        console.error('Image upload failed:', error);
        return res.status(400).json({
          success: false,
          message: 'Image upload failed',
          error: error.message
        });
      }
    }

    await meditation.save();
    console.log('Meditation updated successfully:', meditation._id);

    const updatedObj = withClientIdString(await meditation.populate('clientId', 'clientId'));
    if (updatedObj.videoKey) { try { updatedObj.videoUrl = await getPresignedUrl(updatedObj.videoKey); } catch(e) {} }
    if (updatedObj.imageKey) { try { updatedObj.imageUrl = await getPresignedUrl(updatedObj.imageKey); } catch(e) {} }
    res.json({ success: true, message: 'Meditation updated successfully', data: updatedObj });
  } catch (error) {
    console.error('=== MEDITATION UPDATE ERROR ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({
      success: false,
      message: 'Failed to update meditation',
      error: error.message
    });
  }
});

// DELETE /api/meditations/:id - Delete meditation (permanent delete)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    console.log('=== DELETE MEDITATION REQUEST ===');
    console.log('Meditation ID:', req.params.id);
    
    let clientId;
    try {
      clientId = await getClientId(req);
      console.log('Client ID:', clientId?.toString());
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    const meditation = await Meditation.findOneAndDelete({
      _id: req.params.id,
      clientId: clientId
    });

    if (!meditation) {
      console.log('❌ Meditation not found');
      return res.status(404).json({
        success: false,
        message: 'Meditation not found'
      });
    }

    console.log('✅ Meditation deleted from database:', meditation._id.toString());

    // Delete files from S3 (prefer keys over URLs)
    if (meditation.videoKey || meditation.videoUrl) {
      try {
        await deleteFile(meditation.videoKey || meditation.videoUrl);
        console.log('✅ Video deleted from S3');
      } catch (error) {
        console.error('Failed to delete video from S3:', error);
      }
    }
    if (meditation.imageKey || meditation.imageUrl) {
      try {
        await deleteFile(meditation.imageKey || meditation.imageUrl);
        console.log('✅ Image deleted from S3');
      } catch (error) {
        console.error('Failed to delete image from S3:', error);
      }
    }

    res.json({
      success: true,
      message: 'Meditation deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting meditation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete meditation',
      error: error.message
    });
  }
});

// PATCH /api/meditations/:id/toggle-status - Toggle meditation status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }

    const meditation = await Meditation.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!meditation) {
      return res.status(404).json({
        success: false,
        message: 'Meditation not found'
      });
    }

    meditation.isActive = !meditation.isActive;
    await meditation.save();

    res.json({
      success: true,
      message: `Meditation ${meditation.isActive ? 'enabled' : 'disabled'} successfully`,
      data: { isActive: meditation.isActive }
    });
  } catch (error) {
    console.error('Error toggling meditation status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle meditation status',
      error: error.message
    });
  }
});

export default router;