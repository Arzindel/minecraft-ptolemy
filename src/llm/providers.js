'use strict';

// The LLM backends Ptolemy knows. They all speak the OpenAI chat-completions API, so they only
// differ in where they live, whether they need a key, and how well they handle native tool calls.
const PROVIDERS = [
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    toolMode: 'auto',
    urlHelp: 'Start the server in LM Studio (Developer tab, or `lms server start`). Default port 1234.',
    keyHelp: 'Not needed unless you turned on authentication in LM Studio.',
    modelHelp: 'Empty = the first model LM Studio lists. Pick one with tool-use support (the hammer icon) for native tool calls.',
  },
  {
    id: 'oobabooga',
    label: 'text-generation-webui (oobabooga)',
    baseUrl: 'http://localhost:5000/v1',
    model: '',
    toolMode: 'text',
    urlHelp: 'Start text-generation-webui with --api (the OpenAI-compatible API listens on port 5000).',
    keyHelp: 'Only if you started it with --api-key.',
    modelHelp: 'Empty = whatever model is loaded in the WebUI.',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA Build',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    toolMode: 'auto',
    urlHelp: 'NVIDIA\'s hosted API (build.nvidia.com).',
    keyHelp: 'An nvapi-... key from build.nvidia.com (or set the NVIDIA_API_KEY environment variable).',
    modelHelp: 'Any chat model from build.nvidia.com that supports tool calling, e.g. meta/llama-3.3-70b-instruct.',
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible server',
    baseUrl: 'http://localhost:8000/v1',
    model: '',
    toolMode: 'auto',
    urlHelp: 'Anything with /v1/chat/completions: Ollama (http://localhost:11434/v1), llama.cpp server, vLLM, OpenAI...',
    keyHelp: 'If the server needs one.',
    modelHelp: 'Empty = the first model the server lists.',
  },
];

const TOOL_MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'native', label: 'Native' },
  { value: 'text', label: 'Text (in the prompt)' },
];

const ENV_KEYS = { nvidia: 'NVIDIA_API_KEY' };

/** The selected provider's connection details, from settings (plus environment fallbacks). */
function providerConfig(settings, id = settings.get('llm.provider')) {
  const preset = PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
  const get = (name) => settings.get(`llm.${preset.id}.${name}`);
  return {
    id: preset.id,
    label: preset.label,
    baseUrl: String(get('baseUrl') || preset.baseUrl).replace(/\/+$/, ''),
    apiKey: get('apiKey') || process.env[ENV_KEYS[preset.id]] || process.env.PTOLEMY_LLM_API_KEY || '',
    model: get('model') || '',
    toolMode: get('toolMode') || preset.toolMode,
  };
}

module.exports = { PROVIDERS, TOOL_MODES, providerConfig };
