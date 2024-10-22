const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new mongoose.Schema({
  fname: {
    type: String,
    required: true,
  },
  lname: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true
  },
  token: {
    type: String
  },
  confirmed: {
    type: Boolean,
    default: false
  },
  confirmationToken: {
    type: String
  },
  bios: {
    type: String
  },
  whatsapp: {
    type: String
  },
  phonecall: {
    type: String
  },
  image: {
    type: String,
  },
  role : { type: String, enum: {
    values: ['user', 'admin', 'super-admin'],
    message: '{VALUE} is not supported'
  }},

  postCount: { type: Number, default: 0 },  // Track the number of posts made
  subscriptionPlan: {
    type: String, // Can be 'free', 'monthly', 'quarterly', 'annually'
    default: 'free'
  },
  subscriptionExpiry: { type: Date },  // Expiration date for subscription

  subscriptionStartDate: Date,
  subscriptionDuration: Number,
  trialStartDate: {
    type: Date,
    default: Date.now
  },
  monthlyEndDate: {
    type: Date,
    default: Date.now
  },
  quarterlyEndDate: {
    type: Date,
    default: null
  },
  annualEndDate: {
    type: Date,
    default: null
  },
  subscriptionType: {
    type: String,
    enum: ['trialStartDate', 'monthlyEndDate', 'quarterlyEndDate', "annualEndDate", "You have no plan yet", "your plan has expired" ],
    required: true,
    default: 'trialStartDate'
  },
  likes: {
    type: Number,
    default: 0
  },
  followers: {
    type: Number,
    default: 0
  },
  likedBy: [String],
  followedBy: [String],
  Items: [
    {
      type: Schema.Types.ObjectId,
      ref: 'Item',
    },
  ],
},
{
  timestamps: true,
});

let User;
try {
  User = mongoose.model("User");
} catch {
  User = mongoose.model("User", UserSchema);
}
module.exports = User;
