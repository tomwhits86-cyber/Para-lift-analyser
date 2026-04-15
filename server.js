const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Pool } = require('pg');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const client = new Anthropic({ apiKey: API_KEY });

// Database pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialise database tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      salt VARCHAR(255) NOT NULL,
      credits INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      verified BOOLEAN DEFAULT FALSE,
      verification_token VARCHAR(255)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      athlete VARCHAR(255),
      load VARCHAR(255),
      angle VARCHAR(100),
      verdict VARCHAR(50),
      overall_score INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database tables initialised');
}

initDB().catch(console.error);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Hash password with salt
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

// Generate secure token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Auth middleware
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  
  try {
    const result = await pool.query(
      'SELECT s.user_id, u.email, u.credits FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = $1 AND s.expires_at > NOW()',
      [token]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = result.rows[0];
    next();
  } catch(err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// REGISTER
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  
  try {
    const salt = generateToken();
    const passwordHash = hashPassword(password, salt);
    const verificationToken = generateToken();
    
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, salt, verification_token) VALUES ($1, $2, $3, $4) RETURNING id, email',
      [email.toLowerCase(), passwordHash, salt, verificationToken]
    );
    
    res.json({ 
      success: true, 
      message: 'Account created successfully. You can now log in.',
      user: { id: result.rows[0].id, email: result.rows[0].email }
    });
  } catch(err) {
    if (err.code === '23505') return res.status(400).json({ error: 'An account with this email already exists' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });
    
    const user = result.rows[0];
    const hash = hashPassword(password, user.salt);
    if (hash !== user.password_hash) return res.status(401).json({ error: 'Invalid email or password' });
    
    // Create session — 30 days
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );
    
    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, credits: user.credits }
    });
  } catch(err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// LOGOUT
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ success: true });
});

// GET USER (check session + credits)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ 
    user: { 
      email: req.user.email, 
      credits: req.user.credits 
    } 
  });
});

// STRIPE WEBHOOK — add credits on payment
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  // For now accept all events — add Stripe signature verification when going live
  let event;
  try {
    event = JSON.parse(req.body);
  } catch(err) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    const amount = session.amount_total; // in pence
    
    if (!email) {
      console.log('Webhook: no email in session');
      return res.json({ received: true });
    }
    
    // Determine credits based on amount paid
    let creditsToAdd = 0;
    if (amount === 1500) creditsToAdd = 10;       // £15 Starter
    else if (amount === 3500) creditsToAdd = 30;  // £35 Training Block
    else if (amount === 9900) creditsToAdd = 100; // £99 Squad
    
    if (creditsToAdd > 0) {
      try {
        await pool.query(
          'UPDATE users SET credits = credits + $1 WHERE email = $2',
          [creditsToAdd, email.toLowerCase()]
        );
        console.log(`Added ${creditsToAdd} credits to ${email}`);
      } catch(err) {
        console.error('Failed to add credits:', err);
      }
    }
  }
  
  res.json({ received: true });
});

// MANUAL CREDIT ADD (admin use — protected by secret)
app.post('/api/admin/credits', async (req, res) => {
  const { secret, email, credits } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  
  try {
    const result = await pool.query(
      'UPDATE users SET credits = credits + $1 WHERE email = $2 RETURNING email, credits',
      [credits, email.toLowerCase()]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, email: result.rows[0].email, newBalance: result.rows[0].credits });
  } catch(err) {
    res.status(500).json({ error: 'Failed to add credits' });
  }
});

// VIDEO ANALYSIS — requires auth and credits
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, function(err, metadata) {
      if (err) return reject(err);
      resolve(parseFloat(metadata.format.duration || 0));
    });
  });
}

function extractSurveyFrames(videoPath, count) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const frames = [];
    ffmpeg(videoPath)
      .screenshots({ count, folder: tmpDir, filename: 'survey-%i.png', size: '320x?' })
      .on('end', () => {
        try {
          for (let i = 1; i <= count; i++) {
            const filePath = path.join(tmpDir, 'survey-' + i + '.png');
            if (fs.existsSync(filePath)) {
              const buf = fs.readFileSync(filePath);
              frames.push({ base64: buf.toString('base64'), mediaType: 'image/png' });
              fs.unlinkSync(filePath);
            }
          }
          resolve(frames);
        } catch(err) { reject(err); }
      })
      .on('error', reject);
  });
}

async function extractFramesInWindow(videoPath, windowStart, windowEnd, frameCount) {
  const tmpDir = os.tmpdir();
  const safeStart = Math.max(0, windowStart - 0.1);
  const safeEnd = windowEnd + 0.3;
  const windowDuration = safeEnd - safeStart;
  const timestamps = [];
  for (let i = 0; i < frameCount; i++) {
    const fraction = frameCount === 1 ? 0.5 : i / (frameCount - 1);
    timestamps.push(Math.max(0, safeStart + fraction * windowDuration));
  }
  const frames = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const filename = 'rlframe-' + i + '-' + Date.now() + '.png';
    const filePath = path.join(tmpDir, filename);
    try {
      await new Promise(function(resolve, reject) {
        ffmpeg(videoPath).seekInput(ts).frames(1).output(filePath).size('640x?').on('end', resolve).on('error', reject).run();
      });
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        frames.push({ base64: buf.toString('base64'), mediaType: 'image/png', timestamp: ts, index: i });
        fs.unlinkSync(filePath);
      }
    } catch(err) {
      const adjustedTs = Math.max(0, ts - 0.1);
      try {
        const fn2 = 'rlframe-retry-' + i + '-' + Date.now() + '.png';
        const fp2 = path.join(tmpDir, fn2);
        await new Promise(function(resolve, reject) {
          ffmpeg(videoPath).seekInput(adjustedTs).frames(1).output(fp2).size('640x?').on('end', resolve).on('error', reject).run();
        });
        if (fs.existsSync(fp2)) {
          const buf = fs.readFileSync(fp2);
          frames.push({ base64: buf.toString('base64'), mediaType: 'image/png', timestamp: adjustedTs, index: i });
          fs.unlinkSync(fp2);
        }
      } catch(err2) { console.log('Frame ' + i + ' failed on retry'); }
    }
  }
  return frames;
}

async function detectLiftBoundaries(surveyFrames, duration) {
  const frameInterval = duration / surveyFrames.length;
  const content = [{
    type: 'text',
    text: `These ${surveyFrames.length} frames are evenly spaced across a ${duration.toFixed(1)} second video, one frame every ${frameInterval.toFixed(1)} seconds. Frame 1 is at ${frameInterval.toFixed(1)}s, Frame ${surveyFrames.length} is at ${duration.toFixed(1)}s.\n\nThis is a para powerlifting bench press video. Identify:\n1. LIFT_START: The frame number where the athlete is settled on the bench and the lift is about to begin.\n2. UNRACK: The frame number where the bar leaves the rack hooks.\n3. CHEST_TOUCH: The frame number where the bar makes contact with the chest/sternum.\n4. LOCKOUT: The frame number where the elbows reach full extension at the top.\n5. LIFT_END: The frame number where the bar is returned to the rack.\n\nRespond ONLY with JSON: {"lift_start_frame": N, "unrack_frame": N, "chest_touch_frame": N, "lockout_frame": N, "lift_end_frame": N, "notes": "brief observation"}`
  }];
  surveyFrames.forEach(function(frame, i) {
    content.push({ type: 'text', text: 'Frame ' + (i + 1) + ':' });
    content.push({ type: 'image', source: { type: 'base64', media_type: frame.mediaType, data: frame.base64 } });
  });
  const response = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content }] });
  const text = response.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not detect lift boundaries');
  const boundaries = JSON.parse(match[0]);
  const fi = duration / surveyFrames.length;
  return {
    liftStart: Math.max(0, (boundaries.lift_start_frame - 1) * fi),
    unrack: Math.max(0, (boundaries.unrack_frame - 1) * fi),
    chestTouch: Math.max(0, (boundaries.chest_touch_frame - 1) * fi),
    lockout: Math.max(0, (boundaries.lockout_frame - 1) * fi),
    liftEnd: Math.min(duration, (boundaries.lift_end_frame - 1) * fi),
    notes: boundaries.notes || ''
  };
}

function buildFrameLabels(frameCount, boundaries) {
  const { liftStart, unrack, chestTouch, lockout, liftEnd } = boundaries;
  const totalDuration = liftEnd - liftStart;
  const labels = [];
  for (let i = 0; i < frameCount; i++) {
    const fraction = frameCount === 1 ? 0.5 : i / (frameCount - 1);
    const estimatedTime = liftStart + fraction * totalDuration;
    let label;
    if (estimatedTime <= liftStart + (unrack - liftStart) * 0.7) {
      label = 'SETUP PHASE - Assess body position, bench contact, stability before lift begins.';
    } else if (estimatedTime <= unrack + (chestTouch - unrack) * 0.3) {
      label = 'UNRACK PHASE - Bar leaving rack hooks. Assess initial arm extension and stability.';
    } else if (estimatedTime <= unrack + (chestTouch - unrack) * 0.75) {
      label = 'DESCENT PHASE - Bar travelling toward chest. Assess bar control, path, and speed of descent.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.15) {
      label = 'CHEST TOUCH / PAUSE START - Bar at or near chest. Assess chest contact and beginning of pause.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.35) {
      label = 'MID PAUSE - Bar should be completely stationary on chest.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.5) {
      label = 'PRESS INITIATION - Lifter beginning upward drive.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.7) {
      label = 'EARLY CONCENTRIC - Bar moving upward. Assess drive, sticking point, bar path.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.88) {
      label = 'MID TO LATE CONCENTRIC - Bar approaching lockout.';
    } else if (estimatedTime <= lockout + (liftEnd - lockout) * 0.3) {
      label = 'LOCKOUT - Assess full and simultaneous elbow extension.';
    } else {
      label = 'POST LOCKOUT / RACK - Bar being returned to rack.';
    }
    labels.push(label);
  }
  return labels;
}

function buildAngleGuidance(angle) {
  if (angle === '45 degree / Referee angle') {
    return `CAMERA ANGLE: 45 degree Referee position (diagonal from end of bench).
CAN ASSESS with high confidence: elbow lockout (simultaneous and full), pause quality and chest contact, body stability, elbow and wrist alignment, uneven pressing.
CANNOT fully assess: precise vertical bar path, exact bar displacement for velocity calculation.`;
  } else if (angle === 'Side-on') {
    return `CAMERA ANGLE: Side-on view (perpendicular to bench).

WHAT CAN BE ASSESSED FROM SIDE-ON:
- Bar path in the sagittal plane (vertical travel, forward/backward drift)
- Descent control and bar speed on the way down
- Sticking point location during the concentric phase
- General setup: bridging, head position, foot placement (front-to-back only)
- Concentric mean velocity (only when a 450mm plate is visible and calibration confirmed)

WHAT CANNOT BE ASSESSED FROM SIDE-ON — MANDATORY RULES:
You MUST apply every one of the following. These are not optional.

1. DESCENT AND CHEST TOUCH: Mark as WARNING.
   Detail: "Chest contact cannot be confirmed from a side-on view. The loaded plate sits between the camera and the bar-to-chest contact point, obscuring the moment of touch. A 45-degree referee angle is required to assess chest contact."

2. PAUSE QUALITY: Mark as WARNING.
   Detail: "Pause quality cannot be reliably assessed from a side-on view. Chest contact is not visible from this angle, meaning the start of the pause cannot be confirmed. A 45-degree referee angle is required to assess pause stillness and duration."

3. ELBOW LOCKOUT — SIMULTANEOUS AND FULL: Mark as WARNING.
   Detail: "Simultaneous elbow lockout cannot be assessed from a side-on view. One arm is directly behind the other, making it impossible to confirm both elbows locked out at the same moment. A 45-degree referee angle is required for lockout assessment."

4. ELBOW AND WRIST ALIGNMENT: Mark as WARNING.
   Detail: "Elbow and wrist alignment relative to the bar cannot be assessed from a side-on view. The lateral position of the elbows is not visible from this angle. A 45-degree or front angle is required."

5. UNEVEN PRESSING: Mark as WARNING.
   Detail: "Pressing symmetry cannot be assessed from a side-on view. Any height differential between the left and right sides of the bar is not visible from this angle. A front or 45-degree angle is required."

6. START POSITION AND BODY STABILITY — PARTIAL ONLY: You may comment on front-to-back body position (bridging, head, feet on floor) but you MUST NOT comment on lateral stability or shoulder/buttock contact symmetry.

STRICT RULE: Do NOT mark items 1-5 as Pass or Fail. They must all be Warning. The only rules you may give Pass or Fail on from side-on are Bar Path and Steering, and front-to-back elements of Start Position.`;
  } else if (angle === 'Front') {
    return `CAMERA ANGLE: Front-on view (from head end of bench).
CAN ASSESS with high confidence: elbow symmetry, uneven pressing, lateral bar drift, body width stability.
CANNOT reliably assess: chest touch, pause quality, lockout completeness.
IMPORTANT LIMITATIONS:
- Descent and Chest Touch: Mark as WARNING. "Cannot assess chest contact from front angle."
- Pause Quality: Mark as WARNING. "Cannot assess pause from front angle."`;
  } else {
    return `CAMERA ANGLE: Rear view (from rack end of bench).
CAN ASSESS: elbow symmetry from behind, body stability, head position.
CANNOT reliably assess: chest touch, pause, bar path depth, lockout completion.
Be conservative - only assess what is clearly visible. Mark uncertain areas as WARNING.`;
  }
}

function buildVelocityInstructions(angle, plateCalibrated) {
  if (angle !== 'Side-on') {
    return `VELOCITY: This camera angle does not support velocity estimation. Set "bar_speed_estimate" to null, "velocity_category" to null, and "velocity_coaching_note" to null.`;
  }
  if (plateCalibrated) {
    return `VELOCITY - PLATE-CALIBRATED ESTIMATION (SIDE-ON VIEW):
The user has confirmed a 450mm diameter competition or Olympic bumper plate is visible.
CALIBRATION METHOD:
1. Identify the plate pixel diameter. pixels_per_mm = plate_pixel_diameter / 450.
2. Track bar vertical displacement between concentric frames ONLY (chest touch to lockout — do NOT include descent, pause, or rack).
3. Convert pixel displacement to mm, then to metres.
4. Calculate mean concentric velocity: total displacement (m) / total concentric time (s).
5. Report as numeric value in m/s to 2 decimal places.
- "velocity_category": "Explosive" >0.80, "Optimal" 0.55-0.80, "Grind" 0.35-0.54, "Maximal Effort" <0.35
- "velocity_coaching_note": one sentence coaching implication, do not begin with category name.`;
  } else {
    return `VELOCITY: No 450mm calibration plate confirmed. Set "bar_speed_estimate" to null, "velocity_category" to null, "velocity_coaching_note" to null.`;
  }
}

async function analyzeFrames(labelledFrames, athlete, sessionType, weightClass, bodyweight, load, coachNotes, angle, boundaries, plateCalibrated) {
  const angleGuidance = buildAngleGuidance(angle);
  const velocityInstructions = buildVelocityInstructions(angle, plateCalibrated);
  
  const systemPrompt = `You are an elite technical analyst for RefLight, specialising in para powerlifting referee outcome prediction. You assess bench press attempts against World Para Powerlifting (WPP) Technical Rules.

${angleGuidance}

CRITICAL CONTEXT - WPP RULES:
WPP PARA POWERLIFTING COMMAND STRUCTURE:
- START command: Given by Head Referee once athlete is visibly stable with bar at arms length.
- PAUSE / PRESS: NO mandatory PRESS command in WPP. Lifter presses on own initiative or coach cue. Assess STILLNESS and DURATION of pause only.
- RACK command: Given once both elbows are fully and simultaneously locked out.

WPP RULES TO ASSESS:
1. START POSITION AND STABILITY: Supine, shoulders and buttocks maintaining bench contact. No bridging.
2. DESCENT AND CHEST TOUCH: Bar lowered to chest under control. No bouncing. Must touch chest/sternum.
3. PAUSE QUALITY: Bar completely motionless on chest before upward movement.
4. ELBOW LOCKOUT - SIMULTANEOUS AND FULL: Both elbows lock out simultaneously and completely.
5. BODY STABILITY: No shifting. No loss of bench contact.
6. BAR PATH AND STEERING: No lateral drift. Vertical travel.
7. ELBOW AND WRIST ALIGNMENT: Elbows tracking under bar, wrists stacked.
8. UNEVEN PRESSING: Both sides pressing at equal height and speed.

${velocityInstructions}

LANGUAGE STYLE:
- NEVER reference frames, frame numbers, or timestamps.
- Use natural coaching language: "In the video...", "During the descent...", "At chest contact...", "Through the concentric phase..."
- NEVER mention any person other than the athlete.
- Write as an expert coach giving feedback after watching a training video.

Respond ONLY with valid JSON:
{
  "overall_score": 0-100,
  "setup_score": 0-100,
  "pause_score": 0-100,
  "press_score": 0-100,
  "bar_speed_estimate": <number or null>,
  "velocity_category": "Explosive or Optimal or Grind or Maximal Effort or null",
  "velocity_coaching_note": "coaching implication or null",
  "verdict": "Green or Amber or Red",
  "verdict_headline": "max 8 words",
  "summary": "2-3 sentences. Referee outcome and why.",
  "rule_adherence": [
    {"rule": "Start Position and Body Stability", "status": "Pass or Fail or Warning", "detail": "observation"},
    {"rule": "Descent and Chest Touch", "status": "Pass or Fail or Warning", "detail": "observation"},
    {"rule": "Pause Quality", "status": "Pass or Fail or Warning", "detail": "observation"},
    {"rule": "Elbow Lockout - Simultaneous and Full", "status": "Pass or Fail or Warning", "detail": "observation"},
    {"rule": "Bar Path and Steering", "status": "Pass or Fail or Warning", "detail": "observation"},
    {"rule": "Elbow and Wrist Alignment", "status": "Pass or Fail or Warning", "detail": "observation"},
    {"rule": "Uneven Pressing", "status": "Pass or Fail or Warning", "detail": "observation"}
  ],
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "technical_corrections": ["correction 1", "correction 2"],
  "coaching_cues": ["cue 1", "cue 2", "cue 3"]
}`;

  const userPrompt = 'Athlete: ' + athlete + '\nWeight class: ' + weightClass + '\nBodyweight: ' + bodyweight + '\nSession: ' + sessionType + ' at ' + load + '\nCamera angle: ' + angle + '\nPlate calibration confirmed: ' + (plateCalibrated ? 'YES' : 'NO') + '\nCoach notes: ' + (coachNotes || 'None') + '\n\nLift detection notes: ' + (boundaries.notes || 'Not available') + '\n\nAnalyse these ' + labelledFrames.length + ' frames. Return JSON only.';

  const content = [{ type: 'text', text: userPrompt }];
  labelledFrames.forEach(function(frame) {
    content.push({ type: 'text', text: 'FRAME [' + frame.label + '] at ' + frame.timestamp.toFixed(2) + 's:' });
    content.push({ type: 'image', source: { type: 'base64', media_type: frame.mediaType, data: frame.base64 } });
  });

  const response = await client.messages.create({
   model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content }],
  });

  const text = response.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse response');
  return JSON.parse(match[0]);
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/analyze', requireAuth, upload.single('video'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });
    
    // Check credits
    if (req.user.credits < 1) {
      try { fs.unlinkSync(req.file.path); } catch(e) {}
      return res.status(402).json({ error: 'No credits remaining. Please purchase a credit pack at ref-light.co.uk' });
    }

    const athlete = req.body.athlete || 'Athlete';
    const sessionType = req.body.sessionType || 'Training';
    const weightClass = req.body.weightClass || 'Not specified';
    const bodyweight = req.body.bodyweight || 'Not specified';
    const load = req.body.load || 'Not specified';
    const coachNotes = req.body.coachNotes || '';
    const angle = req.body.angle || 'Side-on';
    const plateCalibrated = req.body.plateCalibrated === 'true';

    console.log('Analysing for ' + athlete + ' (user: ' + req.user.email + ') - credits: ' + req.user.credits);

    // Deduct credit immediately to prevent double-use
    await pool.query('UPDATE users SET credits = credits - 1 WHERE id = $1', [req.user.user_id]);

    const duration = await getVideoDuration(req.file.path);
    const surveyCount = Math.min(12, Math.max(6, Math.floor(duration * 1.5)));
    const surveyFrames = await extractSurveyFrames(req.file.path, surveyCount);
    const boundaries = await detectLiftBoundaries(surveyFrames, duration);
    
    const windowStart = Math.max(0, boundaries.liftStart);
    const windowEnd = Math.min(duration, boundaries.liftEnd + 0.5);
    const targetedFrames = await extractFramesInWindow(req.file.path, windowStart, windowEnd, 12);

    try { fs.unlinkSync(req.file.path); } catch(e) {}

    if (targetedFrames.length === 0) return res.status(400).json({ error: 'Could not extract frames from video' });

    const labels = buildFrameLabels(targetedFrames.length, boundaries);
    const labelledFrames = targetedFrames.map(function(frame, i) {
      return { ...frame, label: labels[i] || ('Frame ' + (i+1)) };
    });

    const analysis = await analyzeFrames(labelledFrames, athlete, sessionType, weightClass, bodyweight, load, coachNotes, angle, boundaries, plateCalibrated);

    // Log analysis
    await pool.query(
      'INSERT INTO analyses (user_id, athlete, load, angle, verdict, overall_score) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.user_id, athlete, load, angle, analysis.verdict, analysis.overall_score]
    );

    // Get updated credit balance
    const creditResult = await pool.query('SELECT credits FROM users WHERE id = $1', [req.user.user_id]);
    const remainingCredits = creditResult.rows[0]?.credits || 0;

    res.json({
      success: true,
      data: analysis,
      metadata: {
        framesAnalyzed: labelledFrames.length,
        videoDuration: duration,
        boundaries,
        plateCalibrated,
        remainingCredits,
        timestamp: new Date().toISOString()
      }
    });

  } catch(err) {
    console.error('Error:', err);
    // Refund credit on error
    try {
      await pool.query('UPDATE users SET credits = credits + 1 WHERE id = $1', [req.user.user_id]);
    } catch(refundErr) { console.error('Credit refund failed:', refundErr); }
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, function() {
  console.log('RefLight Lift Analyser running on port ' + PORT);
});
