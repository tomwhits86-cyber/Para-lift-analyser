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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(1);
}

const client = new Anthropic({ apiKey: API_KEY });

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Get video duration in seconds
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, function(err, metadata) {
      if (err) return reject(err);
      const duration = metadata.format.duration || 0;
      resolve(parseFloat(duration));
    });
  });
}

// Extract evenly spaced survey frames for lift detection
function extractSurveyFrames(videoPath, count) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const frames = [];
    ffmpeg(videoPath)
      .screenshots({
        count: count,
        folder: tmpDir,
        filename: 'survey-%i.png',
        size: '320x?',
      })
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
        } catch (err) {
          reject(err);
        }
      })
      .on('error', reject);
  });
}

// Extract frames at specific timestamps
function extractFramesAtTimestamps(videoPath, timestamps) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const frames = [];
    let completed = 0;
    const results = new Array(timestamps.length).fill(null);

    if (timestamps.length === 0) return resolve([]);

    timestamps.forEach(function(ts, idx) {
      const filename = 'target-' + idx + '-' + Date.now() + '.png';
      const filePath = path.join(tmpDir, filename);

      ffmpeg(videoPath)
        .seekInput(ts)
        .frames(1)
        .output(filePath)
        .size('640x?')
        .on('end', function() {
          try {
            if (fs.existsSync(filePath)) {
              const buf = fs.readFileSync(filePath);
              results[idx] = { base64: buf.toString('base64'), mediaType: 'image/png', timestamp: ts };
              fs.unlinkSync(filePath);
            }
          } catch(e) {}
          completed++;
          if (completed === timestamps.length) {
            resolve(results.filter(Boolean));
          }
        })
        .on('error', function(err) {
          completed++;
          if (completed === timestamps.length) {
            resolve(results.filter(Boolean));
          }
        })
        .run();
    });
  });
}

// Pass 1: Detect lift start and end using survey frames
async function detectLiftBoundaries(surveyFrames, duration) {
  const frameInterval = duration / surveyFrames.length;
  
  const content = [
    {
      type: 'text',
      text: `These ${surveyFrames.length} frames are evenly spaced across a ${duration.toFixed(1)} second video, one frame every ${frameInterval.toFixed(1)} seconds. Frame 1 is at ${frameInterval.toFixed(1)}s, Frame ${surveyFrames.length} is at ${duration.toFixed(1)}s.

This is a para powerlifting bench press video. Identify:
1. LIFT_START: The frame number where the athlete is settled on the bench and the lift is about to begin (athlete positioned, bar loaded, stable on bench). Include any pre-lift stability period.
2. UNRACK: The frame number where the bar leaves the rack hooks.
3. CHEST_TOUCH: The frame number where the bar makes contact with the chest/sternum.
4. LOCKOUT: The frame number where the elbows reach full extension at the top.
5. LIFT_END: The frame number where the bar is returned to the rack.

If you cannot identify a specific moment, estimate based on what you can see.

Respond ONLY with JSON: {"lift_start_frame": N, "unrack_frame": N, "chest_touch_frame": N, "lockout_frame": N, "lift_end_frame": N, "notes": "brief observation"}`
    }
  ];

  surveyFrames.forEach(function(frame, i) {
    content.push({
      type: 'text',
      text: 'Frame ' + (i + 1) + ':'
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: frame.mediaType, data: frame.base64 }
    });
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: content }],
  });

  const text = response.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not detect lift boundaries');
  
  const boundaries = JSON.parse(match[0]);
  const frameInterval2 = duration / surveyFrames.length;
  
  // Convert frame numbers to timestamps
  return {
    liftStart: Math.max(0, (boundaries.lift_start_frame - 1) * frameInterval2),
    unrack: Math.max(0, (boundaries.unrack_frame - 1) * frameInterval2),
    chestTouch: Math.max(0, (boundaries.chest_touch_frame - 1) * frameInterval2),
    lockout: Math.max(0, (boundaries.lockout_frame - 1) * frameInterval2),
    liftEnd: Math.min(duration, (boundaries.lift_end_frame - 1) * frameInterval2),
    notes: boundaries.notes || ''
  };
}

// Build targeted timestamps across the lift
function buildTargetTimestamps(boundaries, duration) {
  const { liftStart, unrack, chestTouch, lockout, liftEnd } = boundaries;
  
  const timestamps = [];
  const labels = [];

  // Setup and stability phase (2 frames)
  timestamps.push(liftStart);
  labels.push('Setup and bench stability - assess body position before lift begins');
  
  const midSetup = liftStart + (unrack - liftStart) * 0.5;
  if (midSetup > liftStart + 0.3) {
    timestamps.push(midSetup);
    labels.push('Pre-unrack position - assess stability and readiness');
  }

  // Unrack
  timestamps.push(unrack);
  labels.push('Unrack - bar leaving rack hooks, arms extended');

  // Descent phase (2 frames)
  const descent1 = unrack + (chestTouch - unrack) * 0.4;
  timestamps.push(descent1);
  labels.push('Mid descent - assess bar control and path');

  const descent2 = unrack + (chestTouch - unrack) * 0.85;
  timestamps.push(descent2);
  labels.push('Near chest - assess bar path and approach to chest');

  // Chest touch and pause (3 frames - critical for rule assessment)
  timestamps.push(chestTouch);
  labels.push('CHEST TOUCH - bar contact with chest/sternum. Assess for bounce. This is where the WPP pause begins - bar must become completely motionless.');

  const pauseMid = chestTouch + 0.4;
  if (pauseMid < lockout - 0.2) {
    timestamps.push(pauseMid);
    labels.push('MID PAUSE - bar should be completely motionless. Assess stillness. Is the bar visibly stationary? WPP requires a visible motionless pause - no PRESS command needed but pause must satisfy the Head Referee.');
  }

  const pauseEnd = chestTouch + 0.8;
  if (pauseEnd < lockout - 0.1) {
    timestamps.push(pauseEnd);
    labels.push('PRESS INITIATION - moment lifter begins press. Was the preceding pause sufficiently motionless and long enough to satisfy a WPP Head Referee? Lifter does not need to wait for a referee PRESS command under WPP rules.');
  }

  // Concentric phase (3 frames - for velocity and rule assessment)
  const press1 = chestTouch + (lockout - chestTouch) * 0.25;
  timestamps.push(press1);
  labels.push('Early concentric - assess initial drive and bar path off chest');

  const press2 = chestTouch + (lockout - chestTouch) * 0.55;
  timestamps.push(press2);
  labels.push('Mid concentric - assess sticking point and bar path');

  const press3 = chestTouch + (lockout - chestTouch) * 0.85;
  timestamps.push(press3);
  labels.push('Near lockout - assess elbow extension progress and symmetry');

  // Lockout (critical)
  timestamps.push(lockout);
  labels.push('LOCKOUT - full elbow extension. Assess simultaneous lockout and completeness. Would referee give RACK command here?');

  // Post lockout / rack (1 frame)
  const postLockout = lockout + (liftEnd - lockout) * 0.5;
  if (postLockout < liftEnd - 0.2) {
    timestamps.push(postLockout);
    labels.push('Post lockout / rack - assess bar return and lift completion');
  }

  return { timestamps, labels };
}

function buildAngleGuidance(angle) {
  if (angle === '45 degree / Referee angle') {
    return `CAMERA ANGLE: 45 degree Referee position (diagonal from end of bench).
CAN ASSESS with high confidence: elbow lockout (simultaneous and full), pause quality and chest contact, body stability, elbow and wrist alignment, uneven pressing.
CANNOT fully assess: precise vertical bar path, exact bar displacement for velocity calculation.
For lockout: you have clear view of both elbows. Assess simultaneous lockout with HIGH CONFIDENCE.
For pause: you can see the bar on the chest clearly. Assess pause quality with HIGH CONFIDENCE.`;
  } else if (angle === 'Side-on') {
    return `CAMERA ANGLE: Side-on view (perpendicular to bench).
CAN ASSESS with high confidence: bar path (vertical and horizontal drift), body position relative to bench, descent control, sticking point location, bar speed estimation if plates are visible.
CANNOT reliably assess: simultaneous elbow lockout (one arm obscures the other), elbow symmetry, uneven pressing height.
IMPORTANT LIMITATIONS - you MUST apply these:
- Elbow Lockout Simultaneous and Full: Mark as WARNING. State "Cannot confirm simultaneous lockout from side-on view. One arm obscures the other. Referee angle required for definitive lockout assessment."
- Uneven Pressing: Mark as WARNING. State "Cannot confirm pressing symmetry from side-on view. Front or referee angle required."
Do NOT mark these as Pass or Fail from side-on.`;
  } else if (angle === 'Front') {
    return `CAMERA ANGLE: Front-on view (from head end of bench).
CAN ASSESS with high confidence: elbow symmetry, uneven pressing, lateral bar drift, body width stability.
CANNOT reliably assess: chest touch (obscured by athlete), pause quality, lockout completeness.
IMPORTANT LIMITATIONS:
- Descent and Chest Touch: Mark as WARNING. State "Cannot assess chest contact from front angle."
- Pause Quality: Mark as WARNING. State "Cannot assess pause from front angle."`;
  } else {
    return `CAMERA ANGLE: Rear view (from rack end of bench).
CAN ASSESS: elbow symmetry from behind, body stability, head position.
CANNOT reliably assess: chest touch, pause, bar path depth, lockout completion.
Be conservative - only assess what is clearly visible. Mark uncertain areas as WARNING with explanation.`;
  }
}

async function analyzeFrames(labelledFrames, athlete, sessionType, weightClass, bodyweight, load, coachNotes, angle, boundaries) {
  const angleGuidance = buildAngleGuidance(angle);
  
  const systemPrompt = `You are an elite technical analyst for RefLight, specialising in para powerlifting referee outcome prediction. You assess bench press attempts against World Para Powerlifting (WPP) Technical Rules.

${angleGuidance}

CRITICAL CONTEXT - WPP RULES AND REFEREE COMMANDS:
This is a training video. There are NO referee commands visible. Apply WPP rules correctly as follows:

WPP PARA POWERLIFTING COMMAND STRUCTURE:
- START command: Given by the Head Referee once the athlete is visibly stable on the bench with the bar at arms length. The athlete must wait for this before lowering the bar.
- PAUSE / PRESS: Under WPP rules, there is NO mandatory PRESS command from the referee. The lifter may initiate the press themselves, or their coach may give a verbal command. However the pause must be visibly motionless and of sufficient duration to satisfy the Head Referee. If the referee judges the pause was insufficient or the bar moved before being stationary, it is a red light. Assess the QUALITY and STILLNESS of the pause, not whether the lifter waited for a referee command.
- RACK command: Given by the Head Referee once both elbows are fully and simultaneously locked out.

This is fundamentally different from IPF able-bodied rules where a PRESS command from the referee is mandatory. Do NOT apply IPF pause rules to WPP lifts.

For each rule, assess: "If this had been a WPP competition lift, would a Head Referee have given white lights or red lights for this aspect?"

WPP RULES TO ASSESS:
1. START POSITION AND STABILITY: Supine, shoulders and buttocks maintaining bench contact. Head may be raised. No bridging. Athlete must be visibly stable before receiving START command.
2. DESCENT AND CHEST TOUCH: Bar lowered to chest under control. No bouncing. Bar must touch chest/sternum.
3. PAUSE QUALITY: Bar completely motionless on chest. Any upward movement before inferred PRESS command = red light. Was the pause long enough and still enough for a referee to give PRESS command?
4. PRESS: Controlled continuous upward movement after inferred PRESS command. No hitching or downward movement.
5. ELBOW LOCKOUT - SIMULTANEOUS AND FULL: Both elbows lock out simultaneously and completely. Any lag between left and right = red light.
6. BODY STABILITY: No shifting during lift. No loss of bench contact.
7. BAR PATH AND STEERING: No lateral drift or rolling. Vertical travel.
8. ELBOW AND WRIST ALIGNMENT: Elbows tracking under bar, wrists stacked.
9. UNEVEN PRESSING: Both sides pressing at equal height and speed throughout.

Only assess what is visible from the stated camera angle. Apply the angle limitations strictly.

Respond ONLY with valid JSON:
{
  "overall_score": 0-100,
  "setup_score": 0-100,
  "pause_score": 0-100,
  "press_score": 0-100,
  "bar_speed_estimate": "estimated m/s from concentric frames",
  "velocity_category": "Maximal (>0.8m/s) or Strength (0.5-0.8m/s) or Grind (<0.5m/s)",
  "verdict": "Green or Amber or Red",
  "verdict_headline": "max 8 words - referee outcome prediction",
  "summary": "2-3 sentences. State what the inferred referee outcome would be and why. Reference angle limitations.",
  "rule_adherence": [
    {"rule": "Start Position and Body Stability", "status": "Pass or Fail or Warning", "detail": "specific observation with referee outcome prediction"},
    {"rule": "Descent and Chest Touch", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Pause Quality", "status": "Pass or Fail or Warning", "detail": "WPP: was the bar completely motionless and held long enough to satisfy a Head Referee? Lifter does not need to wait for a referee PRESS command. Assess stillness and duration only."},
    {"rule": "Press Command Response", "status": "Pass or Fail or Warning", "detail": "WPP: lifter may press on own accord or on coach command. Assess whether the press began from a position of complete stillness or whether bar moved prematurely before being fully motionless."},
    {"rule": "Elbow Lockout - Simultaneous and Full", "status": "Pass or Fail or Warning", "detail": "assess or note angle limitation"},
    {"rule": "Bar Path and Steering", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Elbow and Wrist Alignment", "status": "Pass or Fail or Warning", "detail": "specific observation or note angle limitation"},
    {"rule": "Uneven Pressing", "status": "Pass or Fail or Warning", "detail": "assess or note angle limitation"}
  ],
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "technical_corrections": ["correction with specific WPP rule reference", "correction 2"],
  "coaching_cues": ["cue 1 - short and gym-floor ready", "cue 2", "cue 3"],
  "rep_quality_profile": [85]
}`;

  const userPrompt = 'Athlete: ' + athlete + '\nWeight class: ' + weightClass + '\nBodyweight: ' + bodyweight + '\nSession: ' + sessionType + ' at ' + load + '\nCamera angle: ' + angle + '\nCoach notes: ' + (coachNotes || 'None') + '\n\nLift detection notes: ' + (boundaries.notes || 'Not available') + '\n\nAnalyse these ' + labelledFrames.length + ' frames. Each frame is labelled with its position in the lift. Apply WPP rules inferring where referee commands would have been given. Respect camera angle limitations strictly. Return JSON only.';

  const content = [{ type: 'text', text: userPrompt }];
  
  labelledFrames.forEach(function(frame) {
    content.push({
      type: 'text',
      text: 'FRAME [' + frame.label + '] at ' + frame.timestamp.toFixed(2) + 's:'
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: frame.mediaType, data: frame.base64 }
    });
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: systemPrompt,
    messages: [{ role: 'user', content: content }],
  });

  const text = response.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse response');
  return JSON.parse(match[0]);
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/analyze', upload.single('video'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });
    
    const athlete = req.body.athlete || 'Athlete';
    const sessionType = req.body.sessionType || 'Training';
    const weightClass = req.body.weightClass || 'Not specified';
    const bodyweight = req.body.bodyweight || 'Not specified';
    const load = req.body.load || 'Not specified';
    const coachNotes = req.body.coachNotes || '';
    const angle = req.body.angle || 'Side-on';

    console.log('Analysing for ' + athlete + ' at ' + load + ' - ' + angle);

    // Get video duration
    const duration = await getVideoDuration(req.file.path);
    console.log('Video duration: ' + duration.toFixed(1) + 's');

    // Pass 1: Extract survey frames for lift detection
    const surveyCount = Math.min(12, Math.max(6, Math.floor(duration * 1.5)));
    console.log('Extracting ' + surveyCount + ' survey frames for lift detection...');
    const surveyFrames = await extractSurveyFrames(req.file.path, surveyCount);

    // Detect lift boundaries
    console.log('Detecting lift boundaries...');
    const boundaries = await detectLiftBoundaries(surveyFrames, duration);
    console.log('Boundaries detected:', JSON.stringify(boundaries));

    // Build targeted timestamps
    const { timestamps, labels } = buildTargetTimestamps(boundaries, duration);
    console.log('Extracting ' + timestamps.length + ' targeted frames...');

    // Pass 2: Extract targeted frames
    const targetedFrames = await extractFramesAtTimestamps(req.file.path, timestamps);

    // Clean up video file
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    if (targetedFrames.length === 0) {
      return res.status(400).json({ error: 'Could not extract frames from video' });
    }

    // Label frames
    const labelledFrames = targetedFrames.map(function(frame, i) {
      return {
        base64: frame.base64,
        mediaType: frame.mediaType,
        timestamp: frame.timestamp,
        label: labels[i] || ('Frame ' + (i + 1))
      };
    });

    console.log('Sending ' + labelledFrames.length + ' labelled frames to Claude...');

    // Analyse
    const analysis = await analyzeFrames(labelledFrames, athlete, sessionType, weightClass, bodyweight, load, coachNotes, angle, boundaries);

    res.json({
      success: true,
      data: analysis,
      metadata: {
        framesAnalyzed: labelledFrames.length,
        videoDuration: duration,
        boundaries: boundaries,
        timestamp: new Date().toISOString()
      }
    });

  } catch(err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, function() {
  console.log('RefLight Lift Analyser running on port ' + PORT);
});
