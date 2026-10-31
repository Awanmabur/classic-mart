import mongoose from 'mongoose';
import { activeFeatureMap } from '../services/stage9.js';

export async function featureContext(request, response, next) {
  try {
    const identity = request.user?.publicId || request.session?.cartKey || request.ip || 'anonymous';
    const features = mongoose.connection.readyState === 1
      ? await activeFeatureMap({ country: request.country?.code, role: request.user?.role || 'customer', identity })
      : {};
    request.features = features;
    response.locals.features = features;
    next();
  } catch (error) { next(error); }
}
