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

// Extract exactly frameCount frames sequentially at equal intervals within a confirmed window
// Sequential extraction avoids race conditions and guarantees consistent frame count
async function extractFramesInWindow(videoPath, windowStart, windowEnd, frameCount) {
  const tmpDir = os.tmpdir();
  
  // Add small safety margins
  const safeStart = Math.max(0, windowStart - 0.1);
  const safeEnd = windowEnd + 0.3;
  const windowDuration = safeEnd - safeStart;
  
  // Calculate equal interval timestamps
  const timestamps = [];
  for (let i = 0; i < frameCount; i++) {
    const fraction = frameCount === 1 ? 0.5 : i / (frameCount - 1);
    const ts = safeStart + fraction * windowDuration;
    timestamps.push(Math.max(0, ts));
  }
  
  console.log('Extracting ' + frameCount + ' frames sequentially from ' + safeStart.toFixed(2) + 's to ' + safeEnd.toFixed(2) + 's');
  console.log('Timestamps:', timestamps.map(function(t) { return t.toFixed(2); }).join(', '));
  
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
      // Try with a slightly adjusted timestamp
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

// Generate descriptive labels for equal-interval frames based on position within lift
// Boundaries are used only for labelling, not for timestamp calculation
function buildFrameLabels(frameCount, boundaries) {
  const { liftStart, unrack, chestTouch, lockout, liftEnd } = boundaries;
  const totalDuration = liftEnd - liftStart;
  
  const labels = [];
  
  for (let i = 0; i < frameCount; i++) {
    const fraction = frameCount === 1 ? 0.5 : i / (frameCount - 1);
    const estimatedTime = liftStart + fraction * totalDuration;
    
    let label;
    
    // Assign label based on estimated position within lift phases
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

LANGUAGE STYLE - CRITICAL:
Write all feedback in natural coaching language. You are a coach describing what you see in a video, not a technical system reporting data.
- NEVER reference frames, frame numbers, timestamps, or seconds. No "Frame 4", "at 3.94s", "frames 6-7", "the lockout frame", "the supposed lockout frame", "frame sequence", "available frames" or any similar phrasing.
- ALWAYS use natural video description: "In the video...", "The lift shows...", "During the descent...", "At chest contact...", "Through the concentric phase...", "As the bar approaches lockout...", "During the pause..."
- If you cannot assess something due to camera angle or video quality, say "This cannot be fully assessed from this camera angle" — do not reference frames or what was or was not captured.
- Write as an expert coach giving feedback after watching a training video. Every sentence should sound like it came from a person, not a system.

SPOTTER AWARENESS:
Training videos frequently include spotters. Apply these rules strictly:
1. COMPLETELY IGNORE the spotter during setup, unrack, descent, and rack phases. A spotter assisting the unrack or standing nearby is completely normal and must never be mentioned or flagged.
2. ONLY flag spotter contact if there is clear visual evidence of the spotter's hands making contact with the bar or plates specifically during the CONCENTRIC PRESS phase (from chest touch upward). This would suggest the athlete may have received physical assistance during the press itself.
3. If you flag spotter contact during the press, state it once briefly in the summary only. Do not repeat it across multiple rule sections.
4. Do NOT flag spotter proximity, hands near the bar, or hands during pause phase. Only flag definitive contact during the upward press movement.
5. Never describe the lift as potentially invalid due to spotter presence unless hands are clearly on the bar during the concentric phase with obvious upward force.
6. Do NOT penalise scores for spotter presence at any phase.

Respond ONLY with valid JSON:
{
  "overall_score": 0-100,
  "setup_score": 0-100,
  "pause_score": 0-100,
  "press_score": 0-100,
  "bar_speed_estimate": "estimated m/s from concentric frames",
  "velocity_category": "MUST match the bar_speed_estimate value exactly: use Maximal if value >0.8, Strength if value 0.5-0.8, Grind if value <0.5",
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

    // Pass 2: Extract exactly 12 frames at equal intervals within confirmed lift window
    // Use a slightly padded window to ensure we capture full lift including lockout
    const windowStart = Math.max(0, boundaries.liftStart);
    const windowEnd = Math.min(duration, boundaries.liftEnd + 0.5); // Add 0.5s buffer to catch lockout
    const frameCount = 12;
    
    console.log('Extracting ' + frameCount + ' equal-interval frames from ' + windowStart.toFixed(2) + 's to ' + windowEnd.toFixed(2) + 's');
    
    const targetedFrames = await extractFramesInWindow(req.file.path, windowStart, windowEnd, frameCount);

    // Clean up video file
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    if (targetedFrames.length === 0) {
      return res.status(400).json({ error: 'Could not extract frames from video' });
    }

    // Generate labels based on frame positions within lift phases
    const labels = buildFrameLabels(targetedFrames.length, boundaries);
    
    // Label frames
    const labelledFrames = targetedFrames.map(function(frame, i) {
      return {
        base64: frame.base64,
        mediaType: frame.mediaType,
        timestamp: frame.timestamp,
        label: labels[i] || ('Frame ' + (i + 1) + '/' + targetedFrames.length)
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
