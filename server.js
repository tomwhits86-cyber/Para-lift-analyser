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

function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, function(err, metadata) {
      if (err) return reject(err);
      const duration = metadata.format.duration || 0;
      resolve(parseFloat(duration));
    });
  });
}

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

async function extractFramesInWindow(videoPath, windowStart, windowEnd, frameCount) {
  const tmpDir = os.tmpdir();
  const safeStart = Math.max(0, windowStart - 0.1);
  const safeEnd = windowEnd + 0.3;
  const windowDuration = safeEnd - safeStart;
  
  const timestamps = [];
  for (let i = 0; i < frameCount; i++) {
    const fraction = frameCount === 1 ? 0.5 : i / (frameCount - 1);
    const ts = safeStart + fraction * windowDuration;
    timestamps.push(Math.max(0, ts));
  }
  
  console.log('Extracting ' + frameCount + ' frames sequentially from ' + safeStart.toFixed(2) + 's to ' + safeEnd.toFixed(2) + 's');
  
  const frames = [];
  
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const filename = 'rlframe-' + i + '-' + Date.now() + '.png';
    const filePath = path.join(tmpDir, filename);
    
    try {
      await new Promise(function(resolve, reject) {
        ffmpeg(videoPath)
          .seekInput(ts)
          .frames(1)
          .output(filePath)
          .size('640x?')
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        frames.push({
          base64: buf.toString('base64'),
          mediaType: 'image/png',
          timestamp: ts,
          index: i
        });
        fs.unlinkSync(filePath);
        console.log('Frame ' + (i+1) + '/' + frameCount + ' extracted at ' + ts.toFixed(2) + 's');
      }
    } catch(err) {
      console.log('Frame ' + (i+1) + ' failed at ' + ts.toFixed(2) + 's:', err.message);
      const adjustedTs = Math.max(0, ts - 0.1);
      try {
        const filename2 = 'rlframe-retry-' + i + '-' + Date.now() + '.png';
        const filePath2 = path.join(tmpDir, filename2);
        await new Promise(function(resolve, reject) {
          ffmpeg(videoPath)
            .seekInput(adjustedTs)
            .frames(1)
            .output(filePath2)
            .size('640x?')
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        if (fs.existsSync(filePath2)) {
          const buf = fs.readFileSync(filePath2);
          frames.push({
            base64: buf.toString('base64'),
            mediaType: 'image/png',
            timestamp: adjustedTs,
            index: i
          });
          fs.unlinkSync(filePath2);
          console.log('Frame ' + (i+1) + ' extracted on retry at ' + adjustedTs.toFixed(2) + 's');
        }
      } catch(err2) {
        console.log('Frame ' + (i+1) + ' failed on retry too:', err2.message);
      }
    }
  }
  
  console.log('Successfully extracted ' + frames.length + '/' + frameCount + ' frames');
  return frames;
}

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
    content.push({ type: 'text', text: 'Frame ' + (i + 1) + ':' });
    content.push({ type: 'image', source: { type: 'base64', media_type: frame.mediaType, data: frame.base64 } });
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
  
  return {
    liftStart: Math.max(0, (boundaries.lift_start_frame - 1) * frameInterval2),
    unrack: Math.max(0, (boundaries.unrack_frame - 1) * frameInterval2),
    chestTouch: Math.max(0, (boundaries.chest_touch_frame - 1) * frameInterval2),
    lockout: Math.max(0, (boundaries.lockout_frame - 1) * frameInterval2),
    liftEnd: Math.min(duration, (boundaries.lift_end_frame - 1) * frameInterval2),
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
      label = 'SETUP PHASE - Assess body position, bench contact, stability before lift begins. WPP START command readiness. Write feedback referring to the video not frame numbers.';
    } else if (estimatedTime <= unrack + (chestTouch - unrack) * 0.3) {
      label = 'UNRACK PHASE - Bar leaving rack hooks. Assess initial arm extension and stability.';
    } else if (estimatedTime <= unrack + (chestTouch - unrack) * 0.75) {
      label = 'DESCENT PHASE - Bar travelling toward chest. Assess bar control, path, and speed of descent.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.15) {
      label = 'CHEST TOUCH / PAUSE START - Bar at or near chest. CRITICAL: Assess chest contact, any bounce, and beginning of WPP pause. Bar must become completely motionless here.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.35) {
      label = 'MID PAUSE - Bar should be completely stationary on chest. CRITICAL for WPP: Is bar visibly motionless? Would a Head Referee be satisfied with the stillness at this point?';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.5) {
      label = 'PRESS INITIATION - Lifter beginning upward drive. WPP: Was the bar fully still before press began? No mandatory PRESS command needed but pause must have been complete.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.7) {
      label = 'EARLY CONCENTRIC - Bar moving upward. Assess drive off chest, any sticking point beginning, bar path.';
    } else if (estimatedTime <= chestTouch + (lockout - chestTouch) * 0.88) {
      label = 'MID TO LATE CONCENTRIC - Bar approaching lockout. Assess sticking point, elbow extension progress, any asymmetry.';
    } else if (estimatedTime <= lockout + (liftEnd - lockout) * 0.3) {
      label = 'LOCKOUT - CRITICAL: Assess full and simultaneous elbow extension. Both elbows must lock out at same time. Any lag = red light. Would referee give RACK command?';
    } else {
      label = 'POST LOCKOUT / RACK - Bar being returned to rack. Assess completion of lift.';
    }
    
    labels.push(label);
  }
  
  return labels;
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

WHAT CAN BE ASSESSED FROM SIDE-ON:
- Bar path in the sagittal plane (vertical travel, forward/backward drift)
- Descent control and bar speed on the way down
- Sticking point location during the concentric phase
- General setup: bridging, head position, foot placement (front-to-back only)
- Concentric mean velocity (only when a 450mm plate is visible and calibration confirmed)

WHAT CANNOT BE ASSESSED FROM SIDE-ON — MANDATORY RULES:
You MUST apply every one of the following. These are not optional. Do not attempt to assess these from a side-on angle regardless of what you think you can see.

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

6. START POSITION AND BODY STABILITY — PARTIAL ONLY: You may comment on front-to-back body position (bridging, head, feet on floor) but you MUST NOT comment on lateral stability, lateral shifting, or shoulder/buttock contact symmetry as these are not visible from this angle.

STRICT RULE: Do NOT mark any of items 1-5 as Pass or Fail. They must all be Warning. Any attempt to assess these from side-on is inaccurate and misleading. The only rules you may give a Pass or Fail on from side-on are Bar Path and Steering, and the front-to-back elements of Start Position and Body Stability.`;
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

function buildVelocityInstructions(angle, plateCalibrated) {
  if (angle !== 'Side-on') {
    return `VELOCITY: This camera angle does not support velocity estimation. Set "bar_speed_estimate" to null, "velocity_category" to null, and "velocity_coaching_note" to null. Do not attempt to estimate velocity from this angle.`;
  }
  
  if (plateCalibrated) {
    return `VELOCITY - PLATE-CALIBRATED ESTIMATION (SIDE-ON VIEW):
The user has confirmed that a 450mm diameter competition or Olympic bumper plate is visible in the video. Use this as your calibration reference.

CALIBRATION METHOD:
1. Identify the plate in the frame. Standard 450mm diameter plates are typically 20kg or 25kg calibrated steel competition plates or Olympic bumper plates.
2. Estimate the plate's pixel diameter in the frame. This gives you a pixels-per-mm ratio: pixels_per_mm = plate_pixel_diameter / 450.
3. Track the bar's vertical displacement between concentric frames (chest touch to lockout only — do NOT include descent or setup).
4. Convert pixel displacement to real-world millimetres using your calibration ratio.
5. Calculate mean concentric velocity: total bar displacement (mm) converted to metres, divided by total concentric time (seconds).
6. Report as a numeric value in m/s to 2 decimal places.

CRITICAL CONSTRAINTS:
- Measure CONCENTRIC PHASE ONLY: from the moment the bar leaves the chest to the moment of full lockout. Do not include the descent, pause, or rack phases.
- If the plate is partially obscured or you cannot confidently estimate its pixel diameter, still attempt calibration but note the uncertainty.
- This is still an AI visual estimate, not a laser-measured value. Be conservative rather than overconfident.
- "velocity_category": assign based on numeric value — "Explosive" if >0.80, "Optimal" if 0.55–0.80, "Grind" if 0.35–0.54, "Maximal Effort" if <0.35.
- "velocity_coaching_note": one sentence stating the coaching implication. Do NOT begin with the category name.`;
  } else {
    return `VELOCITY: The user has not confirmed a 450mm calibration plate is visible. Set "bar_speed_estimate" to null, "velocity_category" to null, and "velocity_coaching_note" to null. Do not attempt to estimate velocity without plate calibration on a side-on view.`;
  }
}

async function analyzeFrames(labelledFrames, athlete, sessionType, weightClass, bodyweight, load, coachNotes, angle, boundaries, plateCalibrated) {
  const angleGuidance = buildAngleGuidance(angle);
  const velocityInstructions = buildVelocityInstructions(angle, plateCalibrated);
  
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
3. PAUSE QUALITY: Bar completely motionless on chest. Any upward movement before inferred PRESS command = red light. Was the pause long enough and still enough for a referee to give PRESS command? NOTE: Under WPP rules the lifter does not wait for a referee PRESS command — the lifter presses on their own initiative or a coach's cue. Assess only whether the bar was fully motionless before upward movement began.
4. ELBOW LOCKOUT - SIMULTANEOUS AND FULL: Both elbows lock out simultaneously and completely. Any lag between left and right = red light.
5. BODY STABILITY: No shifting during lift. No loss of bench contact.
6. BAR PATH AND STEERING: No lateral drift or rolling. Vertical travel.
7. ELBOW AND WRIST ALIGNMENT: Elbows tracking under bar, wrists stacked.
8. UNEVEN PRESSING: Both sides pressing at equal height and speed throughout.

Only assess what is visible from the stated camera angle. Apply the angle limitations strictly.

${velocityInstructions}

LANGUAGE STYLE - CRITICAL:
Write all feedback in natural coaching language. You are a coach describing what you see in a video, not a technical system reporting data.
- NEVER reference frames, frame numbers, timestamps, or seconds. No "Frame 4", "at 3.94s", "frames 6-7", "the lockout frame", "the supposed lockout frame", "frame sequence", "available frames" or any similar phrasing.
- ALWAYS use natural video description: "In the video...", "The lift shows...", "During the descent...", "At chest contact...", "Through the concentric phase...", "As the bar approaches lockout...", "During the pause..."
- If you cannot assess something due to camera angle or video quality, say "This cannot be fully assessed from this camera angle" — do not reference frames or what was or was not captured.
- Write as an expert coach giving feedback after watching a training video. Every sentence should sound like it came from a person, not a system.

PEOPLE IN THE VIDEO — CRITICAL:
Training videos may include other people such as coaches or handlers. Apply these rules strictly:
- NEVER mention, describe, or reference any person other than the athlete in any part of your feedback.
- If the view of any moment is partially limited, state only that the camera angle does not allow a clear assessment at that point.
- Focus entirely on what is visible of the athlete and the bar.

Respond ONLY with valid JSON:
{
  "overall_score": 0-100,
  "setup_score": 0-100,
  "pause_score": 0-100,
  "press_score": 0-100,
  "bar_speed_estimate": <number in m/s or null if not applicable>,
  "velocity_category": "Explosive or Optimal or Grind or Maximal Effort or null",
  "velocity_coaching_note": "coaching implication or null",
  "verdict": "Green or Amber or Red",
  "verdict_headline": "max 8 words - referee outcome prediction",
  "summary": "2-3 sentences. State what the inferred referee outcome would be and why. Reference angle limitations if relevant. Do not mention any person other than the athlete.",
  "rule_adherence": [
    {"rule": "Start Position and Body Stability", "status": "Pass or Fail or Warning", "detail": "specific observation with referee outcome prediction"},
    {"rule": "Descent and Chest Touch", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Pause Quality", "status": "Pass or Fail or Warning", "detail": "WPP: was the bar completely motionless and held long enough?"},
    {"rule": "Elbow Lockout - Simultaneous and Full", "status": "Pass or Fail or Warning", "detail": "assess or note angle limitation"},
    {"rule": "Bar Path and Steering", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Elbow and Wrist Alignment", "status": "Pass or Fail or Warning", "detail": "specific observation or note angle limitation"},
    {"rule": "Uneven Pressing", "status": "Pass or Fail or Warning", "detail": "assess or note angle limitation"}
  ],
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "technical_corrections": ["correction with specific WPP rule reference", "correction 2"],
  "coaching_cues": ["cue 1 - short and gym-floor ready", "cue 2", "cue 3"]
}`;

  const userPrompt = 'Athlete: ' + athlete + '\nWeight class: ' + weightClass + '\nBodyweight: ' + bodyweight + '\nSession: ' + sessionType + ' at ' + load + '\nCamera angle: ' + angle + '\nPlate calibration confirmed: ' + (plateCalibrated ? 'YES - 450mm plate visible' : 'NO') + '\nCoach notes: ' + (coachNotes || 'None') + '\n\nLift detection notes: ' + (boundaries.notes || 'Not available') + '\n\nAnalyse these ' + labelledFrames.length + ' frames. Each frame is labelled with its position in the lift. Apply WPP rules inferring where referee commands would have been given. Respect camera angle limitations strictly. Return JSON only.';

  const content = [{ type: 'text', text: userPrompt }];
  
  labelledFrames.forEach(function(frame) {
    content.push({ type: 'text', text: 'FRAME [' + frame.label + '] at ' + frame.timestamp.toFixed(2) + 's:' });
    content.push({ type: 'image', source: { type: 'base64', media_type: frame.mediaType, data: frame.base64 } });
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
    const plateCalibrated = req.body.plateCalibrated === 'true';

    console.log('Analysing for ' + athlete + ' at ' + load + ' - ' + angle + ' - plate calibrated: ' + plateCalibrated);

    const duration = await getVideoDuration(req.file.path);
    console.log('Video duration: ' + duration.toFixed(1) + 's');

    const surveyCount = Math.min(12, Math.max(6, Math.floor(duration * 1.5)));
    console.log('Extracting ' + surveyCount + ' survey frames for lift detection...');
    const surveyFrames = await extractSurveyFrames(req.file.path, surveyCount);

    console.log('Detecting lift boundaries...');
    const boundaries = await detectLiftBoundaries(surveyFrames, duration);
    console.log('Boundaries detected:', JSON.stringify(boundaries));

    const windowStart = Math.max(0, boundaries.liftStart);
    const windowEnd = Math.min(duration, boundaries.liftEnd + 0.5);
    const frameCount = 12;
    
    console.log('Extracting ' + frameCount + ' equal-interval frames from ' + windowStart.toFixed(2) + 's to ' + windowEnd.toFixed(2) + 's');
    
    const targetedFrames = await extractFramesInWindow(req.file.path, windowStart, windowEnd, frameCount);

    try { fs.unlinkSync(req.file.path); } catch(e) {}

    if (targetedFrames.length === 0) {
      return res.status(400).json({ error: 'Could not extract frames from video' });
    }

    const labels = buildFrameLabels(targetedFrames.length, boundaries);
    
    const labelledFrames = targetedFrames.map(function(frame, i) {
      return {
        base64: frame.base64,
        mediaType: frame.mediaType,
        timestamp: frame.timestamp,
        label: labels[i] || ('Frame ' + (i + 1) + '/' + targetedFrames.length)
      };
    });

    console.log('Sending ' + labelledFrames.length + ' labelled frames to Claude...');

    const analysis = await analyzeFrames(labelledFrames, athlete, sessionType, weightClass, bodyweight, load, coachNotes, angle, boundaries, plateCalibrated);

    res.json({
      success: true,
      data: analysis,
      metadata: {
        framesAnalyzed: labelledFrames.length,
        videoDuration: duration,
        boundaries: boundaries,
        plateCalibrated: plateCalibrated,
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
