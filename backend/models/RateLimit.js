const mongoose = require('mongoose');

// Attempt counters shared by all server processes. MongoDB removes expired ones.
const RateLimitSchema = new mongoose.Schema({
  _id: String,
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true }
});
RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimit', RateLimitSchema);
