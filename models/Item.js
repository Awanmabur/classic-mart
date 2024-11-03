const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ItemSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', required: true
  },
  itemname: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 5
  },
  image1_id: {
      type: String,
      required: false
    },  
  image2_id: {
      type: String,
      required: false
    },
  image3_id: {
      type: String,
      required: false
    },
  image4_id: {
      type: String,
      required: false
    },
  image5_id: {
       type: String,
       required: false
     },
  isPromoted: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
},
{
  timestamps: true,
});

module.exports = mongoose.model('Item', ItemSchema);
