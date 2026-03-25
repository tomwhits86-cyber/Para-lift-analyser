const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(1);
}

const client = new Anthropic({ apiKey: API_KEY });

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
```
5. Commit the change

Then in **Terminal**, type this and press Enter to restart the local server:
```
cd ~/Downloads && python3 -m http.server 8080
app.use(express.json({ limit: '50mb' }));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

async function extractFrames(videoPath, frameCount = 10) {
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
            const filePath = path.join(tmpDir, `bwlframe-${i}.png`);
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
      .on('error', (err) => reject(err));
  });
}

async function analyzeFrames(frames, athlete, sessionType, load, focusAreas, coachNotes, angle) {
  const systemPrompt = `You are an expert biomechanics analyst specialising in para powerlifting for British Weightlifting. Analyse the video frames provided and give detailed feedback.

Para powerlifting context: Athletes compete in bench press only. No leg drive. Setup and technique must account for each athlete's classification and physical profile.

Respond ONLY with valid JSON in this exact structure:
{
  "overall_score": 0-100,
  "technique_score": 0-100,
  "setup_score": 0-100,
  "consistency_score": 0-100,
  "verdict": "Green or Amber or Attention",
  "summary": "2-3 sentence overall assessment",
  "bar_speed_estimate": "number in m/s as string e.g. 0.62",
  "setup_and_position": {
    "strengths": ["finding 1", "finding 2"],
    "improvements": ["finding 1"]
  },
  "bar_path_and_control": {
    "strengths": ["finding 1"],
    "concerns": ["finding 1"]
  },
  "power_output": {
    "assessment": "assessment text",
    "velocity_profile": "velocity description"
  },
  "para_specific_factors": {
    "adaptations": "what adaptations are visible",
    "effectiveness": "how effective they are"
  },
  "rep_quality_profile": [85, 78, 82],
  "immediate_coaching_cues": ["Cue one", "Cue two", "Cue three"],
  "next_session_recommendations": ["Rec one", "Rec two", "Rec three"]
}`;

  const userPrompt = `Athlete: ${athlete}
Session: ${sessionType} at ${load}
Camera angle: ${angle}
Focus: ${Array.isArray(focusAreas) ? focusAreas.join(', ') : focusAreas}
Coach notes: ${coachNotes || 'None'}

These ${frames.length} frames are taken from the concentric phase only (chest to lockout). Estimate bar speed from positional changes between frames. Return JSON only.`;

  const content = [{ type: 'text', text: userPrompt }];

  frames.forEach((frame) => {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: frame.mediaType, data: frame.base64 },
    });
  });

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content }],
  });

  const text = response.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse Claude response');
  return JSON.parse(match[0]);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/analyze', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });

    const { athlete, sessionType, load, focusAreas, coachNotes, angle } = req.body;

    console.log(`Analysing for ${athlete} - ${sessionType} at ${load}`);

    const { frames } = await extractFrames(req.file.path, 10);

    try { fs.unlinkSync(req.file.path); } catch (e) {}

    if (frames.length === 0) {
      return res.status(400).json({ error: 'Could not extract frames from video' });
    }

    console.log(`Extracted ${frames.length} frames, sending to Claude`);

    const analysis = await analyzeFrames(
      frames, athlete, sessionType, load,
      focusAreas, coachNotes, angle
    );

    res.json({
      success: true,
      data: analysis,
      metadata: { framesAnalyzed: frames.length, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`BWL Para Lift Analyser running on port ${PORT}`);
});
