'use strict';

const mongoose = require('mongoose');

const refreshTokenFamilySchema = new mongoose.Schema({
  familyId: { type: String, required: true, unique: true },
  userId: { type: String, default: null, index: true },
  generation: { type: Number, required: true, min: 1 },
  revokedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });

refreshTokenFamilySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RefreshTokenFamily', refreshTokenFamilySchema);
