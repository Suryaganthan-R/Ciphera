const mongoose = require('mongoose');

const SubmissionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  challenge: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Challenge',
    required: true
  },
  // Team the player belonged to when submitting; the solve counts for this team only.
  team: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
    default: null
  },
  submittedFlag: {
    type: String,
    required: true
  },
  isCorrect: {
    type: Boolean,
    required: true
  },
  submittedAt: {
    type: Date,
    default: Date.now
  },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  }
});

// Indexes for better performance
SubmissionSchema.index({ user: 1, submittedAt: -1 });
SubmissionSchema.index({ challenge: 1, submittedAt: -1 });
SubmissionSchema.index({ isCorrect: 1 });
SubmissionSchema.index({ submittedAt: -1 });
// CRITICAL: Unique compound index to prevent race condition exploitation
// Only one correct submission per user per challenge allowed
SubmissionSchema.index({ user: 1, challenge: 1, isCorrect: 1 }, { 
  unique: true, 
  partialFilterExpression: { isCorrect: true },
  name: 'unique_correct_submission'
});
// A team can score each challenge only once, even if two members submit at the same moment.
SubmissionSchema.index({ team: 1, challenge: 1 }, {
  unique: true,
  partialFilterExpression: { isCorrect: true, team: { $type: 'objectId' } },
  name: 'unique_team_correct_submission'
});

module.exports = mongoose.model('Submission', SubmissionSchema);