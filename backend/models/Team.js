const mongoose = require('mongoose');
const crypto = require('crypto');

const TeamSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Team name is required'],
    unique: true,
    trim: true,
    maxlength: [100, 'Team name must be less than 100 characters']
  },
  nameKey: {
    type: String,
    select: false
  },
  passwordHash: {
    type: String,
    select: false
  },
  inviteCode: {
    type: String,
    select: false
  },
  maxMembers: {
    type: Number,
    default: 4,
    min: 1,
    max: 4
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'Description must be less than 500 characters']
  },
  members: {
    type: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    validate: {
      validator: members => members.length <= 4,
      message: 'A team can have at most four members'
    }
  },
  captain: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  points: {
    type: Number,
    default: 0
  },
  // Incremented inside score-changing transactions so concurrent ones conflict and retry.
  scoreRevision: {
    type: Number,
    default: 0,
    select: false
  },
  hidden: {
    type: Boolean,
    default: false
  },
  banned: {
    type: Boolean,
    default: false
  },
  verified: {
    type: Boolean,
    default: false
  },
  website: {
    type: String,
    default: '',
    trim: true
  },
  affiliation: {
    type: String,
    default: '',
    trim: true
  },
  country: {
    type: String,
    default: '',
    trim: true
  },
  solvedChallenges: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Challenge'
  }],
  isBlocked: {
    type: Boolean,
    default: false
  },
  blockedReason: {
    type: String,
    default: null
  },
  blockedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

TeamSchema.pre('validate', function (next) {
  if (this.name) {
    this.nameKey = this.name.trim().toLocaleLowerCase('en');
  }
  if (!this.inviteCode) {
    this.inviteCode = crypto.randomBytes(24).toString('base64url');
  }
  next();
});

TeamSchema.index({ points: -1 });
TeamSchema.index({ createdBy: 1 });
TeamSchema.index({ members: 1 });
TeamSchema.index({ hidden: 1 });
TeamSchema.index({ banned: 1 });
TeamSchema.index({ nameKey: 1 }, { unique: true, sparse: true, name: 'unique_team_name_key' });
TeamSchema.index({ inviteCode: 1 }, { unique: true, sparse: true, name: 'unique_team_invite_code' });

TeamSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.inviteCode;
    return ret;
  }
});

module.exports = mongoose.model('Team', TeamSchema);
