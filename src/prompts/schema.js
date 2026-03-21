const { SchemaType } = require('@google/generative-ai');

/**
 * Gemini structured output 스키마 — JSON 파싱 실패 방지 및 필드 타입 강제
 */
function buildResponseSchema() {
  const segment = {
    type: SchemaType.OBJECT,
    properties: {
      startTime: { type: SchemaType.NUMBER },
      endTime:   { type: SchemaType.NUMBER },
    },
    required: ['startTime', 'endTime'],
  };

  const short = {
    type: SchemaType.OBJECT,
    properties: {
      type:        { type: SchemaType.STRING },
      title:       { type: SchemaType.STRING },
      description: { type: SchemaType.STRING },
      evidence:    { type: SchemaType.STRING },
      virality:    { type: SchemaType.NUMBER },
      startTime:   { type: SchemaType.NUMBER },
      endTime:     { type: SchemaType.NUMBER },
      segments:    { type: SchemaType.ARRAY, items: segment },
    },
    required: ['type', 'title', 'description', 'evidence', 'virality'],
  };

  const music = {
    type: SchemaType.OBJECT,
    properties: {
      title:       { type: SchemaType.STRING },
      mood:        { type: SchemaType.STRING },
      genre:       { type: SchemaType.STRING },
      source:      { type: SchemaType.STRING },
      searchQuery: { type: SchemaType.STRING },
    },
    required: ['title', 'mood', 'genre', 'source', 'searchQuery'],
  };

  return {
    type: SchemaType.OBJECT,
    properties: {
      shorts: { type: SchemaType.ARRAY, items: short },
      music:  { type: SchemaType.ARRAY, items: music },
    },
    required: ['shorts', 'music'],
  };
}

module.exports = { buildResponseSchema };
