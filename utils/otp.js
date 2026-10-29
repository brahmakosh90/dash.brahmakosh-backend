/**
 * OTP Utility Service - Enhanced Version with Gupshup Support
 * Handles generation, validation, and expiration of OTPs for email and mobile verification
 * Supports: Email (Brevo, SendGrid, SMTP), SMS (Twilio, Gupshup), WhatsApp (Facebook API + Twilio)
 */

import nodemailer from 'nodemailer';
import twilio from 'twilio';
import axios from 'axios';
import dotenv from 'dotenv';
import OTP from '../models/OTP.js';

dotenv.config();

// ============================================
// OTP GENERATION & VALIDATION
// ============================================

// Generate a random 6-digit OTP
export const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Set OTP expiry time (10 minutes from now)
export const getOTPExpiry = () => {
  return new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
};

// Check if OTP is expired
export const isOTPExpired = (expiryDate) => {
  return new Date() > new Date(expiryDate);
};

// Validate OTP
export const validateOTP = (storedOTP, providedOTP, expiryDate) => {
  if (!storedOTP || !providedOTP) {
    console.log(storedOTP, providedOTP);
    return { valid: false, message: 'OTP is required' };
  }
  
  if (isOTPExpired(expiryDate)) {
    return { valid: false, message: 'OTP has expired. Please request a new one.' };
  }
  
  if (storedOTP !== providedOTP) {
    return { valid: false, message: 'Invalid OTP. Please try again.' };
  }
  
  return { valid: true, message: 'OTP is valid' };
};

// ============================================
// EMAIL OTP FUNCTIONS
// ============================================

// Create nodemailer transporter
const createEmailTransporter = () => {
  const emailService = process.env.EMAIL_SERVICE || 'gmail';
  
  const connectionOptions = {
    connectionTimeout: parseInt(process.env.SMTP_CONNECTION_TIMEOUT || '120000'),
    greetingTimeout: parseInt(process.env.SMTP_GREETING_TIMEOUT || '60000'),
    socketTimeout: parseInt(process.env.SMTP_SOCKET_TIMEOUT || '120000'),
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    },
    pool: process.env.SMTP_POOL === 'true',
    maxConnections: parseInt(process.env.SMTP_MAX_CONNECTIONS || '5'),
    maxMessages: parseInt(process.env.SMTP_MAX_MESSAGES || '100')
  };

  if (emailService.toLowerCase() === 'gmail') {
    const port = parseInt(process.env.SMTP_PORT || '587');
    const useSSL = port === 465 || process.env.SMTP_SECURE === 'true';
    
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: port,
      secure: useSSL,
      requireTLS: !useSSL,
      ...connectionOptions,
      tls: {
        rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false',
        minVersion: 'TLSv1.2'
      }
    });
  }
  
  if (emailService.toLowerCase() === 'outlook') {
    return nodemailer.createTransport({
      host: 'smtp-mail.outlook.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      requireTLS: true,
      ...connectionOptions,
      tls: {
        rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false'
      }
    });
  }
  
  if (emailService.toLowerCase() === 'yahoo') {
    return nodemailer.createTransport({
      host: 'smtp.mail.yahoo.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      requireTLS: true,
      ...connectionOptions,
      tls: {
        rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false'
      }
    });
  }
  
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_REQUIRE_TLS === 'true',
    ...connectionOptions,
    tls: {
      rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false'
    }
  });
};

// Send email OTP using Brevo (Sendinblue) API
const sendEmailViaBrevo = async (email, otp) => {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER;
  const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || process.env.APP_NAME || 'Brahmakosh';
  const appName = process.env.APP_NAME || 'Brahmakosh';

  if (!BREVO_API_KEY) {
    throw new Error('Brevo API key not configured');
  }

  const url = 'https://api.brevo.com/v3/smtp/email';
  const headers = {
    'api-key': BREVO_API_KEY,
    'Content-Type': 'application/json'
  };

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">OTP Verification</h2>
      <p>Hello,</p>
      <p>Your OTP for ${appName} registration is:</p>
      <div style="background-color: #f4f4f4; padding: 20px; text-align: center; margin: 20px 0;">
        <h1 style="color: #007bff; font-size: 32px; margin: 0; letter-spacing: 5px;">${otp}</h1>
      </div>
      <p>This OTP will expire in <strong>10 minutes</strong>.</p>
      <p>If you didn't request this OTP, please ignore this email.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #999; font-size: 12px;">This is an automated message. Please do not reply.</p>
    </div>
  `;

  const data = {
    sender: {
      name: BREVO_FROM_NAME,
      email: BREVO_FROM_EMAIL
    },
    to: [{ email: email }],
    subject: `Your OTP for ${appName} Registration`,
    htmlContent: emailHtml,
    textContent: `Your OTP for ${appName} registration is: ${otp}. This OTP will expire in 10 minutes.`
  };

  const response = await axios.post(url, data, { headers });
  return response.data;
};

// Send email OTP using SendGrid API
const sendEmailViaSendGrid = async (email, otp) => {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER;
  const appName = process.env.APP_NAME || 'Brahmakosh';

  if (!SENDGRID_API_KEY) {
    throw new Error('SendGrid API key not configured');
  }

  const url = 'https://api.sendgrid.com/v3/mail/send';
  const headers = {
    'Authorization': `Bearer ${SENDGRID_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const data = {
    personalizations: [{
      to: [{ email: email }],
      subject: `Your OTP for ${appName} Registration`
    }],
    from: {
      email: SENDGRID_FROM_EMAIL,
      name: appName
    },
    content: [{
      type: 'text/html',
      value: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">OTP Verification</h2>
          <p>Hello,</p>
          <p>Your OTP for ${appName} registration is:</p>
          <div style="background-color: #f4f4f4; padding: 20px; text-align: center; margin: 20px 0;">
            <h1 style="color: #007bff; font-size: 32px; margin: 0; letter-spacing: 5px;">${otp}</h1>
          </div>
          <p>This OTP will expire in <strong>10 minutes</strong>.</p>
          <p>If you didn't request this OTP, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #999; font-size: 12px;">This is an automated message. Please do not reply.</p>
        </div>
      `
    }]
  };

  const response = await axios.post(url, data, { headers });
  return response.data;
};

// Send email OTP (main function)
export const sendEmailOTP = async (email, otp, options = {}) => {
  const {
    sessionId,
    expiresAt = getOTPExpiry(),
    client = 'brahmakosh',
  } = options;
  
  try {
    if (process.env.EMAIL_ENABLED !== 'true') {
      console.log(`📧 Email OTP for ${email}: ${otp} (Email service disabled - check console)`);
      return { success: true, message: 'OTP sent to email (logged to console)' };
    }

    if (process.env.USE_BREVO === 'true' || process.env.BREVO_API_KEY) {
      try {
        const result = await sendEmailViaBrevo(email, otp);
        console.log(`✅ Email OTP sent via Brevo to ${email}. Message ID: ${result.messageId || 'N/A'}`);
        
        try {
          await OTP.create({
            email,
            otp,
            expiresAt,
            type: 'email',
            client,
            sessionId: sessionId || undefined,
          });
        } catch (dbError) {
          console.warn('Could not save OTP to database collection (OTP is saved in User model):', dbError.message);
        }
        
        return { success: true, message: 'OTP sent to email via Brevo', messageId: result.messageId };
      } catch (brevoError) {
        if (brevoError.code === 'E11000' || brevoError.message?.includes('duplicate key')) {
          console.warn('Database error saving OTP (email was sent successfully):', brevoError.message);
          return { success: true, message: 'OTP sent to email via Brevo (database save failed but email sent)' };
        }
        
        console.error('Brevo API error:', brevoError.response?.data || brevoError.message);
        console.log('⚠️ Brevo API failed, trying alternatives...');
      }
    }

    if (process.env.USE_SENDGRID === 'true' || process.env.SENDGRID_API_KEY) {
      try {
        const result = await sendEmailViaSendGrid(email, otp);
        console.log(`✅ Email OTP sent via SendGrid to ${email}`);
        
        try {
          await OTP.create({
            email,
            otp,
            expiresAt,
            type: 'email',
            client,
            sessionId: sessionId || undefined,
          });
        } catch (dbError) {
          console.warn('Could not save OTP to database collection (OTP is saved in User model):', dbError.message);
        }
        
        return { success: true, message: 'OTP sent to email via SendGrid' };
      } catch (sendGridError) {
        console.error('SendGrid error:', sendGridError.response?.data || sendGridError.message);
        console.log('⚠️ SendGrid failed, falling back to SMTP...');
      }
    }

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.error('Email configuration missing. Please set EMAIL_USER and EMAIL_PASSWORD in .env');
      console.log(`📧 Email OTP for ${email}: ${otp} (Email not configured - check console)`);
      return { success: true, message: 'OTP logged to console (email not configured)' };
    }

    const transporter = createEmailTransporter();
    
    if (process.env.SMTP_VERIFY_CONNECTION === 'true') {
      try {
        await transporter.verify();
        console.log('✅ SMTP server connection verified');
      } catch (verifyError) {
        console.warn('⚠️ SMTP verification failed, but attempting to send anyway:', verifyError.message);
      }
    }
    
    const emailFrom = process.env.EMAIL_FROM || process.env.EMAIL_USER;
    const appName = process.env.APP_NAME || 'Brahmakosh';

    const mailOptions = {
      from: `"${appName}" <${emailFrom}>`,
      to: email,
      subject: `Your OTP for ${appName} Registration`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">OTP Verification</h2>
          <p>Hello,</p>
          <p>Your OTP for ${appName} registration is:</p>
          <div style="background-color: #f4f4f4; padding: 20px; text-align: center; margin: 20px 0;">
            <h1 style="color: #007bff; font-size: 32px; margin: 0; letter-spacing: 5px;">${otp}</h1>
          </div>
          <p>This OTP will expire in <strong>10 minutes</strong>.</p>
          <p>If you didn't request this OTP, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #999; font-size: 12px;">This is an automated message. Please do not reply.</p>
        </div>
      `,
      text: `Your OTP for ${appName} registration is: ${otp}. This OTP will expire in 10 minutes.`
    };

    const maxRetries = parseInt(process.env.SMTP_MAX_RETRIES || '3');
    const emailService = process.env.EMAIL_SERVICE || 'gmail';
    let info;
    let currentTransporter = transporter;
    let triedPort465 = false;
    const originalPort = parseInt(process.env.SMTP_PORT || '587');
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        info = await currentTransporter.sendMail(mailOptions);
        if (attempt > 0) {
          console.log(`✅ Email sent successfully on attempt ${attempt + 1}${triedPort465 ? ' (using port 465)' : ''}`);
        }
        break;
      } catch (sendError) {
        const isTimeoutError = sendError.code === 'ETIMEDOUT' || 
                               sendError.code === 'ECONNRESET' || 
                               sendError.code === 'ESOCKETTIMEDOUT' ||
                               sendError.code === 'ECONNREFUSED' ||
                               sendError.message?.includes('timeout') ||
                               sendError.message?.includes('Connection');
        
        if (attempt === 1 && isTimeoutError && emailService.toLowerCase() === 'gmail' && originalPort === 587 && !triedPort465) {
          console.warn(`⚠️ Port 587 failed, trying port 465 (SSL) as fallback...`);
          triedPort465 = true;
          try {
            currentTransporter.close();
          } catch (closeError) {
            // Ignore
          }
          currentTransporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: {
              user: process.env.EMAIL_USER,
              pass: process.env.EMAIL_PASSWORD
            },
            connectionTimeout: parseInt(process.env.SMTP_CONNECTION_TIMEOUT || '120000'),
            greetingTimeout: parseInt(process.env.SMTP_GREETING_TIMEOUT || '60000'),
            socketTimeout: parseInt(process.env.SMTP_SOCKET_TIMEOUT || '120000'),
            tls: {
              rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false',
              minVersion: 'TLSv1.2'
            }
          });
          continue;
        }
        
        if (attempt < maxRetries && isTimeoutError) {
          const delay = (attempt + 1) * 2000;
          console.warn(`⚠️ Email send attempt ${attempt + 1} failed (${sendError.code || sendError.message}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          try {
            currentTransporter.close();
          } catch (closeError) {
            // Ignore
          }
          currentTransporter = createEmailTransporter();
        } else {
          throw sendError;
        }
      }
    }
    
    console.log(`✅ Email OTP sent to ${email}. Message ID: ${info.messageId}`);
    
    try {
      await OTP.create({
        email,
        otp,
        expiresAt,
        type: 'email',
        client,
        sessionId: sessionId || undefined,
      });
    } catch (dbError) {
      console.warn('Could not save OTP to database collection (OTP is saved in User model):', dbError.message);
    }
    
    return { success: true, message: 'OTP sent to email', messageId: info.messageId };
  } catch (error) {
    console.error('Error sending email OTP:', error);
    
    console.log(`📧 Email OTP for ${email}: ${otp} (Email failed - check console)`);
    return { success: true, message: 'OTP logged to console (email service error)' };
  }
};

// ============================================
// MOBILE OTP FUNCTIONS (SMS & WHATSAPP)
// ============================================

// Create Twilio client for SMS
const createTwilioClient = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return null;
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
};

// Send SMS OTP using Gupshup
const sendSMSViaGupshup = async (mobile, otp) => {
  const GUPSHUP_USERID = process.env.GUPSHUP_USERID;
  const GUPSHUP_PASSWORD = process.env.GUPSHUP_PASSWORD;
  const PRINCIPAL_ENTITY_ID = process.env.PRINCIPAL_ENTITY_ID;
  const MASK = process.env.MASK;
  const appName = process.env.APP_NAME || 'Brahmakosh';

  if (!GUPSHUP_USERID || !GUPSHUP_PASSWORD) {
    throw new Error('Gupshup credentials not configured');
  }

  // ✅ FIX: Format mobile number correctly for Gupshup
  let formattedMobile = mobile.toString().replace(/\s+/g, '').replace(/[-()]/g, '');
  
  // Remove any leading + sign
  formattedMobile = formattedMobile.replace(/^\+/, '');
  
  // If it's a 10-digit number, add country code 91
  if (formattedMobile.length === 10 && !formattedMobile.startsWith('91')) {
    formattedMobile = '91' + formattedMobile;
  }
  
  console.log(`📱 Original mobile: ${mobile}, Formatted for Gupshup: ${formattedMobile}`);

  // Check if this is a default mobile number with default OTP
  const defaultMobileNumbers = (process.env.DEFAULT_MOBILE_NUMBERS || '').split(',').map(n => n.trim());
  const isDefaultMobile = defaultMobileNumbers.includes(mobile.replace(/^\+91/, '').replace(/^91/, ''));
  
  if (isDefaultMobile && otp === '111111') {
    console.log(`📱 Default OTP for ${mobile}: ${otp}`);
    return { success: true, message: 'Default OTP used', sid: 'default' };
  }

  const params = {
    method: 'SendMessage',
    send_to: formattedMobile,  // ✅ Use formatted mobile with country code
    msg: `${otp} is your ${appName} OTP for registration. Valid for 10 minutes.`,
    msg_type: 'TEXT',
    userid: GUPSHUP_USERID,
    auth_scheme: 'plain',
    password: GUPSHUP_PASSWORD,
    v: '1.1',
    format: 'text'
  };

  // Only add optional params if they exist
  if (PRINCIPAL_ENTITY_ID) {
    params.principalEntityId = PRINCIPAL_ENTITY_ID;
  }
  if (MASK) {
    params.mask = MASK;
  }

  console.log('📤 Gupshup API Request:', {
    ...params,
    password: '***HIDDEN***'
  });

  try {
    const response = await axios.get('https://enterprise.smsgupshup.com/GatewayAPI/rest', { 
      params,
      timeout: 30000
    });

    console.log('📥 Gupshup API Response:', response.data);

    // Check for errors in response
    const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    
    if (responseText.toLowerCase().includes('error') || responseText.toLowerCase().includes('fail')) {
      console.error('❌ Gupshup Error Response:', responseText);
      throw new Error('Failed to send OTP via Gupshup: ' + responseText);
    }

    return { success: true, message: 'OTP sent via Gupshup', data: response.data };
  } catch (error) {
    console.error('❌ Gupshup API Error:', error.message);
    if (error.response) {
      console.error('Response Status:', error.response.status);
      console.error('Response Data:', error.response.data);
    }
    throw error;
  }
};

// Send WhatsApp OTP using Facebook Graph API
const sendWhatsAppViaFacebookAPI = async ({ to, otp }) => {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v20.0';

  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    throw new Error('WhatsApp API credentials are not configured');
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
  const headers = {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: process.env.WHATSAPP_TEMPLATE_NAME || 'otp_verification',
      language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US' },
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: otp,
            },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            {
              type: 'text',
              text: otp,
            },
          ],
        },
      ],
    },
  };

  const response = await axios.post(url, data, { headers });
  return response.data;
};

// Send WhatsApp OTP using Twilio
const sendWhatsAppViaTwilio = async (mobile, otp) => {
  const client = createTwilioClient();
  if (!client) {
    throw new Error('Twilio client not initialized');
  }

  if (!process.env.TWILIO_WHATSAPP_NUMBER) {
    throw new Error('TWILIO_WHATSAPP_NUMBER is required for WhatsApp via Twilio');
  }

  const appName = process.env.APP_NAME || 'Brahmakosh';
  
  const whatsappTo = mobile.startsWith('whatsapp:') ? mobile : `whatsapp:${mobile}`;
  const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER.startsWith('whatsapp:') 
    ? process.env.TWILIO_WHATSAPP_NUMBER 
    : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

  const messageBody = `Your ${appName} OTP is: ${otp}. Valid for 10 minutes.`;
  
  const message = await client.messages.create({
    body: messageBody,
    from: whatsappFrom,
    to: whatsappTo
  });
  
  return message;
};

// Send SMS OTP using Twilio
const sendSMSViaTwilio = async (mobile, otp) => {
  const client = createTwilioClient();
  if (!client) {
    throw new Error('Twilio client not initialized');
  }

  if (!process.env.TWILIO_PHONE_NUMBER) {
    throw new Error('TWILIO_PHONE_NUMBER is required for SMS');
  }

  const appName = process.env.APP_NAME || 'Brahmakosh';
  const messageBody = `Your ${appName} OTP is: ${otp}. Valid for 10 minutes.`;
  
  const cleanMobile = mobile.replace(/^whatsapp:/, '');
  
  const message = await client.messages.create({
    body: messageBody,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: cleanMobile
  });
  
  return message;
};

/**
 * Send Mobile OTP - Main function
 * Supports SMS (Twilio, Gupshup) and WhatsApp (Facebook API, Twilio)
 * @param {string} mobile - Mobile number (with country code)
 * @param {string} otp - OTP code
 * @param {string} method - 'twilio', 'gupshup', or 'whatsapp'
 * @returns {Promise<Object>} - Result object with success status
 */
export const sendMobileOTP = async (mobile, otp, method = 'twilio') => {
  try {
    const otpMethod = method.toLowerCase();
    
    if (!['twilio', 'gupshup', 'whatsapp'].includes(otpMethod)) {
      console.error(`Invalid OTP method: ${method}. Must be 'twilio', 'gupshup', or 'whatsapp'`);
      return { success: false, message: 'Invalid OTP method. Must be twilio, gupshup, or whatsapp.' };
    }

    const expiresAt = getOTPExpiry();
    const normalizedMobile = mobile.replace(/^whatsapp:/, '');

    // ====================================
    // WHATSAPP OTP DELIVERY
    // ====================================
    if (otpMethod === 'whatsapp') {
      if (process.env.WHATSAPP_ENABLED !== 'true') {
        console.log(`📱 WhatsApp OTP for ${normalizedMobile}: ${otp} (WhatsApp service disabled - check console)`);
        return { success: true, message: 'OTP sent to WhatsApp (logged to console)' };
      }

      // Try Facebook WhatsApp Business API first
      if (process.env.USE_WHATSAPP_BUSINESS_API === 'true' && 
          process.env.WHATSAPP_TOKEN && 
          process.env.WHATSAPP_PHONE_ID) {
        try {
          const whatsappTo = normalizedMobile.startsWith('+') ? normalizedMobile : `+${normalizedMobile}`;
          const result = await sendWhatsAppViaFacebookAPI({ to: whatsappTo, otp });
          
          console.log(`✅ WhatsApp OTP sent via Facebook API to ${whatsappTo}. Message ID: ${result.messages?.[0]?.id || 'N/A'}`);
          
          try {
            await OTP.updateMany(
              { mobile: normalizedMobile, type: { $in: ['whatsapp', 'sms', 'mobile'] }, isUsed: false },
              { $set: { isUsed: true } }
            );
            
            await OTP.create({
              mobile: normalizedMobile,
              otp,
              expiresAt,
              type: 'whatsapp',
              client: 'brahmakosh'
            });
          } catch (dbError) {
            console.warn('Could not save OTP to database collection (OTP is saved in User model):', dbError.message);
          }
          
          return { 
            success: true, 
            message: 'OTP sent via WhatsApp (Facebook API)', 
            messageId: result.messages?.[0]?.id,
            method: 'whatsapp'
          };
        } catch (fbError) {
          console.error('Facebook WhatsApp API error:', fbError.response?.data || fbError.message);
          console.log('⚠️ Facebook WhatsApp API failed, trying Twilio as fallback...');
        }
      }

      // Fallback to Twilio WhatsApp
      if (process.env.TWILIO_ACCOUNT_SID && 
          process.env.TWILIO_AUTH_TOKEN && 
          process.env.TWILIO_WHATSAPP_NUMBER &&
          process.env.TWILIO_WHATSAPP_ENABLED === 'true') {
        try {
          const message = await sendWhatsAppViaTwilio(normalizedMobile, otp);
          
          console.log(`✅ WhatsApp OTP sent via Twilio to ${normalizedMobile}. Message SID: ${message.sid}`);
          
          try {
            await OTP.updateMany(
              { mobile: normalizedMobile, type: { $in: ['whatsapp', 'sms', 'mobile'] }, isUsed: false },
              { $set: { isUsed: true } }
            );
            
            await OTP.create({
              mobile: normalizedMobile,
              otp,
              expiresAt,
              type: 'whatsapp',
              client: 'brahmakosh'
            });
          } catch (dbError) {
            console.warn('Could not save OTP to database collection (OTP is saved in User model):', dbError.message);
          }
          
          return { 
            success: true, 
            message: 'OTP sent via WhatsApp (Twilio)', 
            messageSid: message.sid,
            method: 'whatsapp'
          };
        } catch (twilioError) {
          console.error('Twilio WhatsApp error:', twilioError);
          
          if (twilioError.code === 63007) {
            console.error('❌ User has not opted in to WhatsApp. User must send a message first.');
            return { 
              success: false, 
              message: 'WhatsApp number not opted in. Please send a WhatsApp message to the Twilio number first.',
              method: 'whatsapp'
            };
          }
          
          throw twilioError;
        }
      }

      console.error('WhatsApp configuration missing. Set WHATSAPP_TOKEN + WHATSAPP_PHONE_ID or TWILIO_WHATSAPP_NUMBER');
      console.log(`📱 WhatsApp OTP for ${normalizedMobile}: ${otp} (WhatsApp not configured - check console)`);
      return { success: true, message: 'OTP logged to console (WhatsApp not configured)', method: 'whatsapp' };
    }

    // ====================================
    // GUPSHUP SMS DELIVERY
    // ====================================
    if (otpMethod === 'gupshup') {
      if (process.env.SMS_ENABLED !== 'true') {
        console.log(`📱 Gupshup SMS OTP for ${normalizedMobile}: ${otp} (SMS service disabled - check console)`);
        return { success: true, message: 'OTP sent via Gupshup (logged to console)' };
      }

      if (!process.env.GUPSHUP_USERID || !process.env.GUPSHUP_PASSWORD) {
        console.error('Gupshup configuration missing. Please set GUPSHUP_USERID and GUPSHUP_PASSWORD in .env');
        console.log(`📱 Gupshup SMS OTP for ${normalizedMobile}: ${otp} (Gupshup not configured - check console)`);
        return { success: true, message: 'OTP logged to console (Gupshup not configured)', method: 'gupshup' };
      }

      const result = await sendSMSViaGupshup(normalizedMobile, otp);
      
      console.log(`✅ Gupshup SMS OTP sent to ${normalizedMobile}`);
      
      try {
        await OTP.updateMany(
          { mobile: normalizedMobile, type: { $in: ['whatsapp', 'sms', 'mobile'] }, isUsed: false },
          { $set: { isUsed: true } }
        );
        
        await OTP.create({
          mobile: normalizedMobile,
          otp,
          expiresAt,
          type: 'sms',
          client: 'brahmakosh'
        });
      } catch (dbError) {
        console.warn('Could not save OTP to database collection (OTP is saved in User model):', dbError.message);
      }
      
      return { 
        success: true, 
        message: 'OTP sent via Gupshup SMS', 
        method: 'gupshup'
      };
    }

    // ====================================
    // TWILIO SMS DELIVERY
    // ====================================
    if (otpMethod === 'twilio') {
      if (process.env.SMS_ENABLED !== 'true') {
        console.log(`📱 Twilio SMS OTP for ${normalizedMobile}: ${otp} (SMS service disabled - check console)`);
        return { success: true, message: 'OTP sent via Twilio (logged to console)' };
      }

      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
        console.error('Twilio configuration missing. Please set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env');
        console.log(`📱 Twilio SMS OTP for ${normalizedMobile}: ${otp} (Twilio not configured - check console)`);
        return { success: true, message: 'OTP logged to console (Twilio not configured)', method: 'twilio' };
      }

      const message = await sendSMSViaTwilio(normalizedMobile, otp);
      
      console.log(`✅ Twilio SMS OTP sent to ${normalizedMobile}. Message SID: ${message.sid}`);
      
      try {
        await OTP.updateMany(
          { mobile: normalizedMobile, type: { $in: ['whatsapp', 'sms', 'mobile'] }, isUsed: false },
          { $set: { isUsed: true } }
        );
        
        await OTP.create({
          mobile: normalizedMobile,
          otp,
          expiresAt,
          type: 'sms',
          client: 'brahmakosh'
        });
      } catch (dbError) {
        console.warn('Could not save OTP to database collection (OTP is saved in User model):', dbError.message);
      }
      
      return { 
        success: true, 
        message: 'OTP sent via Twilio SMS', 
        messageSid: message.sid,
        method: 'twilio'
      };
    }

  } catch (error) {
    console.error(`Error sending ${method} OTP:`, error);
    
    const normalizedMobile = mobile.replace(/^whatsapp:/, '');
    console.log(`📱 ${method.toUpperCase()} OTP for ${normalizedMobile}: ${otp} (${method} failed - check console)`);
    
    return { 
      success: true, 
      message: `OTP logged to console (${method} service error)`,
      method 
    };
  }
};

/**
 * Send WhatsApp OTP - Convenience function (backward compatible)
 */
export const sendWhatsAppOTP = async (mobile, otp) => {
  return sendMobileOTP(mobile, otp, 'whatsapp');
};

// ============================================
// OTP VERIFICATION
// ============================================

export const verifyOTPFromDB = async (mobile, otp, type = 'mobile') => {
  try {
    const normalizedMobile = mobile.replace(/^whatsapp:/, '');
    
    const record = await OTP.findOne({ 
      mobile: normalizedMobile, 
      otp, 
      type: type === 'mobile' ? { $in: ['whatsapp', 'sms', 'mobile'] } : type,
      isUsed: false 
    });
    
    if (!record) {
      return { valid: false, message: 'Invalid OTP' };
    }

    if (new Date(record.expiresAt).getTime() < Date.now()) {
      return { valid: false, message: 'OTP expired' };
    }

    record.isUsed = true;
    await record.save();

    return { valid: true, message: 'OTP verified successfully' };
  } catch (error) {
    console.error('Error verifying OTP from DB:', error);
    return { valid: false, message: 'OTP verification failed' };
  }
};