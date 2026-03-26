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

async function analyzeFrames(frames, athlete, sessionType, load, coachNotes, angle) {
  const systemPrompt = `You are an elite technical analyst for British Weightlifting World Class Programme, specialising in para powerlifting. You assess bench press attempts against the official World Para Powerlifting (WPP) Technical Rules.

WPP RULES YOU MUST ASSESS AGAINST:
1. START POSITION: Athlete must be supine on the bench. Shoulders and buttocks must maintain contact with bench throughout. Head may be raised. Feet flat on floor or on foot platform. No bridging allowed.
2. UNRACK: Bar taken at arms length. Wait for Head Referee START signal before lowering.
3. DESCENT: Bar lowered to chest under control. No bouncing.
4. PAUSE: Bar must be held motionless on chest awaiting PRESS command. Any upward movement before the command is a red light. The pause must be visible and deliberate.
5. PRESS: On PRESS command, bar pressed upward in a controlled, continuous movement. No downward movement after press begins (hitching). 
6. LOCKOUT: Both elbows must lock out simultaneously and fully at the same time. Uneven lockout = red light. Elbows must be straight, not soft.
7. COMPLETION: Bar returned to rack on RACK command from referee.

ADDITIONAL TECHNICAL FACTORS TO ASSESS:
- Elbow position relative to wrist and bar throughout: elbows should track under the bar, wrists stacked. Flared or collapsed elbows are a technical concern.
- Uneven pressing: assess whether one side presses faster or higher than the other, which would cause uneven lockout.
- Bar path: assess whether bar drifts toward head or feet, or steers laterally to one side (rolling or steering).
- Body stability: assess whether hips, shoulders or head shift during the lift. Any loss of contact with bench is a rule violation.
- Pressing technique: smoothness, intent, sticking point location.

Respond ONLY with valid JSON in this exact structure:
{
  "overall_score": 0-100,
  "setup_score": 0-100,
  "pause_score": 0-100,
  "press_score": 0-100,
  "bar_speed_estimate": "e.g. 0.42",
  "velocity_category": "Maximal (>0.8m/s) or Strength (0.5-0.8m/s) or Grind (<0.5m/s)",
  "verdict": "Green or Amber or Red",
  "verdict_headline": "max 8 words summarising the lift",
  "summary": "2-3 sentences overall assessment referencing WPP rules",
  "rule_adherence": [
    {"rule": "Start Position and Body Stability", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Descent and Chest Touch", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Pause Quality", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Press Command Response", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Elbow Lockout - Simultaneous and Full", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Bar Path and Steering", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Elbow and Wrist Alignment", "status": "Pass or Fail or Warning", "detail": "specific observation"},
    {"rule": "Uneven Pressing", "status": "Pass or Fail or Warning", "detail": "specific observation"}
  ],
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "technical_corrections": ["correction 1", "correction 2"],
  "coaching_cues": ["cue 1", "cue 2", "cue 3"],
  "rep_quality_profile": [85, 78, 82]
}`;

  const userPrompt = 'Athlete: ' + athlete + '\nSession: ' + sessionType + ' at ' + load + '\nCamera angle: ' + angle + '\nCoach notes: ' + (coachNotes || 'None') + '\n\nAnalyse these ' + frames.length + ' frames against World Para Powerlifting technical rules. Assess each rule area specifically. Estimate concentric bar speed from positional changes between frames. Return JSON only.';

  const content = [{ type: 'text', text: userPrompt }];
  frames.forEach(function(frame) {
    content.push({ type: 'image', source: { type: 'base64', media_type: frame.mediaType, data: frame.base64 } });
  });

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
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
    const load = req.body.load || 'Not specified';
    const coachNotes = req.body.coachNotes || '';
    const angle = req.body.angle || 'Side-on';
    console.log('Analysing for ' + athlete + ' - ' + load);
    const result = await extractFrames(req.file.path, 10);
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    if (result.frames.length === 0) return res.status(400).json({ error: 'Could not extract frames' });
    console.log('Extracted ' + result.frames.length + ' frames, sending to Claude');
    const analysis = await analyzeFrames(result.frames, athlete, sessionType, load, coachNotes, angle);
    res.json({ success: true, data: analysis, metadata: { framesAnalyzed: result.frames.length, timestamp: new Date().toISOString() } });
  } catch(err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, function() {
  console.log('BWL Para Lift Analyser running on port ' + PORT);
});
