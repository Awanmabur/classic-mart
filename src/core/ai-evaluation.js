export const LOCAL_EVALUATION_PROVIDER = 'local';
export const LOCAL_EVALUATION_MODEL = 'stage10-core-local-v1';

export function evaluationRunProvenance(model, { providerReady = false } = {}) {
  const provider = String(model?.provider || '').trim();
  const modelName = String(model?.model || '').trim();
  if (providerReady && provider && !['disabled', 'local'].includes(provider) && modelName) {
    return { provider, model: modelName };
  }
  return { provider: LOCAL_EVALUATION_PROVIDER, model: LOCAL_EVALUATION_MODEL };
}
