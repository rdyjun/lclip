const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const defaults = require('../src/config/defaults');
const data = JSON.parse(fs.readFileSync('data/projects.json', 'utf8'));

const ids = [
  '7db95efb-62a9-424a-88c5-92f70b7f4e7f',
  '628df888-7d80-4113-808c-aac621109020',
  '7b43fcbf-bd9e-426c-8b64-2bc28422d323',
  'fb473ddb-ad7b-44bc-9d04-a37238e9f853',
  'fe942fe9-ceb8-40f2-8193-08ed8abbfbe9'
];

data.forEach(p => {
  if (ids.indexOf(p.id) === -1) return;

  // Already has a title layer?
  if (p.layers.find(l => l.name === '제목 레이어')) {
    console.log('Skip (already has title layer):', p.name);
    return;
  }

  const videoLayer = p.layers.find(l => l.type === 'video');
  const totalDuration = videoLayer
    ? Math.max.apply(null, videoLayer.clips.map(function(c) { return c.endTime || 0; }))
    : 60;

  // Shift existing layers with order >= 1
  p.layers.forEach(function(l) {
    if (l.order >= 1) l.order += 1;
  });

  // Insert title layer at order 1
  p.layers.push({
    id: uuidv4(),
    type: 'subtitle',
    name: '제목 레이어',
    order: 1,
    locked: false,
    visible: true,
    clips: [{
      id: uuidv4(),
      type: 'subtitle',
      text: p.name,
      startTime: 0,
      endTime: totalDuration,
      x: 540,
      y: 100,
      fontSize: 52,
      fontFamily: defaults.subtitle.fontFamily,
      color: defaults.subtitle.color,
      backgroundColor: defaults.subtitle.backgroundColor,
      backgroundPadding: defaults.subtitle.backgroundPadding,
      borderRadius: defaults.subtitle.borderRadius,
      align: defaults.subtitle.align,
      bold: defaults.subtitle.bold,
      italic: defaults.subtitle.italic,
      shadow: defaults.subtitle.shadow,
      outline: defaults.subtitle.outline,
    }]
  });

  p.updatedAt = new Date().toISOString();
  console.log('Updated:', p.name, '| duration:', totalDuration.toFixed(1));
});

fs.writeFileSync('data/projects.json', JSON.stringify(data, null, 2));
console.log('Done');
