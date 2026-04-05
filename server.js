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

async function extractFrames(videoPath, frameCount) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const frames = [];
    ffmpeg(videoPath)
      .screenshots({
        count: frameCount,
        folder: tmpDir,
        filename: 'bwlframe-%i.png',
        size: '640x?',
      })
      .on('end', () => {
        try {
          for (let i = 1; i <= frameCount; i++) {
            const filePath = path.join(tmpDir, 'bwlframe-' + i + '.png');
            if (fs.existsSync(filePath)) {
              const buf = fs.readFileSync(filePath);
              frames.push({ base64: buf.toString('base64'), mediaType: 'image/png' });
              fs.unlinkSync(filePath);
            }
          }
          resolve({ frames });
        } catch (err) {
          reject(err);
        }
      })
      .on('error', function(err) { reject(err); });
  });
}

function buildAngleGuidance(angle) {
  if (angle === '45 degree / Referee angle') {
    return `CAMERA ANGLE: Referee position (diagonal). This is the BEST angle for WPP rule assessment.
From this angle you CAN assess: elbow lockout (simultaneous and full), pause quality and chest contact, uneven pressing, body stability, elbow and wrist alignment.
From this angle you CANNOT fully assess: precise bar path (some lateral view lost), exact vertical bar displacement for velocity.
For lockout assessment: you have a clear view of both elbows from this angle. Assess simultaneous lockout with high confidence.`;
  } else if (angle === 'Side-on') {
    return `CAMERA ANGLE: Side-on view.
From this angle you CAN assess: bar path (vertical and horizontal drift), body position, descent control, sticking point location, bar speed estimation if plates are visible.
From this angle you CANNOT reliably assess: simultaneous elbow lockout (one arm obscures the other), elbow symmetry, uneven pressing height differential.
IMPORTANT: Do NOT assess simultaneous lockout as pass or fail from side-on view. Mark it as WARNING with the note "Cannot confirm simultaneous lockout from side-on angle - referee angle required for this assessment." Similarly for uneven pressing, note the limitation.`;
  } else if (angle === 'Front') {
    return `CAMERA ANGLE: Front-on view.
From this angle you CAN assess: elbow symmetry, uneven pressing, lateral bar drift, body width stability.
From this angle you CANNOT reliably assess: chest touch (obscured), pause quality, bar path depth, lockout completeness.
IMPORTANT: Mark chest touch and pause as "Cannot assess from front angle" rather than pass or fail.`;
  } else {
    return `CAMERA ANGLE: Rear view.
From this angle you CAN assess: elbow symmetry from behind, body stability, head position.
From this angle you CANNOT reliably assess: chest touch, pause, bar path, lockout completion.
IMPORTANT: Be conservative - only assess what is clearly visible.`;
  }
}

async function analyzeFrames(frames, athlete, sessionType, weightClass, bodyweight, load, coachNotes, angle) {
  const angleGuidance = buildAngleGuidance(angle);

  const systemPrompt = `You are an elite technical analyst for RefLight, specialising in para powerlifting. You assess bench press attempts against the official World Para Powerlifting (WPP) Technical Rules.

${angleGuidance}

WPP RULES TO ASSESS:
1. START POSITION: Athlete supine, shoulders and buttocks maintaining bench contact throughout. Head may be raised. No bridging.
2. DESCENT: Bar lowered to chest under control. No bouncing.
3. PAUSE: Bar held motionless on chest awaiting PRESS command. Any upward movement before command = red light. Pause must be visible and deliberate.
4. PRESS: Controlled continuous upward movement. No hitching.
5. LOCKOUT: Both elbows must lock out simultaneously and fully. Uneven lockout = red light.
6. BODY STABILITY: No shifting of hips, shoulders or head. No loss of bench contact.
7. BAR PATH: No lateral steering or rolling. Bar should travel vertically.
8. ELBOW AND WRIST ALIGNMENT: Elbows tracking under bar, wrists stacked.
9. UNEVEN PRESSING: Both sides must press at equal speed and height.

IMPORTANT: Only assess what is visible from the camera angle provided. If a rule area cannot be assessed from this angle, mark it as WARNING with a clear explanation of why it cannot be confirmed, rather than making an incorrect pass or fail judgment.

Respond ONLY with valid JSON:
{
  "overall_score": 0-100,
  "setup_score": 0-100,
  "pause_score": 0-100,
  "press_score": 0-100,
  "bar_speed_estimate": "e.g. 0.42",
  "velocity_category": "Maximal (>0.8m/s) or Strength (0.5-0.8m/s) or Grind (<0.5m/s)",
  "verdict": "Green or Amber or Red",
  "verdict_headline": "max 8 words",
  "summary": "2-3 sentences referencing WPP rules and camera angle limitations",
  "rule_adherence": [
    {"rule": "Start Position and Body Stability", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Descent and Chest Touch", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Pause Quality", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Press Command Response", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Elbow Lockout - Simultaneous and Full", "status": "Pass or Fail or Warning", "detail": "specific observation - note if cannot be confirmed from this angle"},
    {"rule": "Bar Path and Steering", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Elbow and Wrist Alignment", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Uneven Pressing", "status": "Pass or Fail or Warning", "detail": "specific observation - note if cannot be confirmed from this angle"}
  ],
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "technical_corrections": ["correction 1", "correction 2"],
  "coaching_cues": ["cue 1", "cue 2", "cue 3"],
  "rep_quality_profile": [85, 78, 82]
}`;

  const userPrompt = 'Athlete: ' + athlete + '\nWeight class: ' + weightClass + '\nBodyweight: ' + bodyweight + '\nSession: ' + sessionType + ' at ' + load + '\nCamera angle: ' + angle + '\nCoach notes: ' + (coachNotes || 'None') + '\n\nAnalyse these ' + frames.length + ' frames. Only assess what is visible from the ' + angle + ' angle. For any rule that cannot be confirmed from this angle, mark as Warning and explain. Return JSON only.';

  const content = [{ type: 'text', text: userPrompt }];
  frames.forEach(function(frame) {
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
    console.log('Analysing for ' + athlete + ' - ' + load + ' - ' + angle);
    const result = await extractFrames(req.file.path, 10);
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    if (result.frames.length === 0) return res.status(400).json({ error: 'Could not extract frames' });
    console.log('Extracted ' + result.frames.length + ' frames, sending to Claude');
    const analysis = await analyzeFrames(result.frames, athlete, sessionType, weightClass, bodyweight, load, coachNotes, angle);
    res.json({ success: true, data: analysis, metadata: { framesAnalyzed: result.frames.length, timestamp: new Date().toISOString() } });
  } catch(err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, function() {
  console.log('RefLight Para Lift Analyser running on port ' + PORT);
});
