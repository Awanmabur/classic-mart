const mongoose = require('mongoose');
exports.connectMonggose =()=>{
    mongoose.set("strictQuery", false);
    mongoose.connect(process.env.awsDB,
    {
        useNewUrlParser: true
    })
    .then((e)=>console.log("Connected to Mongodb =>>My E-commerce Website"))
    .catch((e)=>console.log("Not Connect Mongodb"))
}
