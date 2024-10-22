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
  description: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 5
  },
  image1: {
     type: String,
     required: false
   },
  image2: {
    type: String,
    required: false
   },
  image3: {
     type: String,
     required: false
   },
   image4: {
      type: String,
      required: false
    },
   image5: {
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
