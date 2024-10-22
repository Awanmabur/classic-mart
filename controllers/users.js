const User = require("../models/User");
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const jwtSecret = process.env.PRIVATE_KEY;
const nodemailer = require('nodemailer');

// ***transporter***
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USERNAME,
    pass: process.env.EMAIL_PASSWORD,
  },
});


// ***TokenExpired function***
function isTokenExpired(token) {
  try {
    const decoded = jwt.verify(token, process.env.PRIVATE_KEY);
    const currentTime = Math.floor(Date.now() / 1000);
    return decoded.exp < currentTime;
  } catch (error) {
    return true;
  }
}


// ***register route***
exports.register = async (req, res, next) => {
  try {
    const { fname, lname, email, role, password } = req.body;
    // Check whether email exists
    const existingUser = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
    if (existingUser) {
      req.flash('error', 'The Email is already exists in our database, please login');
      return res.redirect('/login');
    }
    // Check if username is at least 4 characters long
    if (fname.length && lname.length < 4) {
      req.flash('error', 'Both first and last Name should be at least 8 characters longer');
      return res.redirect('/signup');
    }
    // Check if password is at least 6 characters long
    if (password.length < 6) {
      req.flash('error', 'Password should be at least 6 characters longer');
      return res.redirect('/signup');
    }
    // hashed password before you store it in the database
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      fname,
      lname,
      email,
      role: "user",
      bios: "i am Simon Awan Mabur, I am this and that psum is simply dummy text of the printing and typesetting industry. Lorem",
      password: hashedPassword
    });
    await user.save();
    const token = jwt.sign({userId: user._id, role: user.role}, 'jwtSecret', {
      expiresIn: '1h',
    });
    req.session.token = token;
    req.flash('welcome', 'welcome to the best first online selling platform');
    res.redirect('/profile');
  } catch (error) {
    req.flash('error', 'There is Error while sigining up, please try again later');
    res.redirect('/signup');
  }
};


// ***logout route***
exports.getLogin = async (req, res, next) => {
  try {
    const user = await User.find({fname:req.user});
    res.render('users/login', { user });
  } catch (error) {
    req.flash('error', 'there is problem while loging in, please try again later');
    res.redirect('/');
  }
};



// ***login route***
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    // Check email matches
    const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
       if (!user) {
         req.flash('error', 'Email does not exists, please signup in order to signin');
         return res.redirect('/signup');
       }
       // Check password matches
       const isPasswordMatch = await bcrypt.compare(password, user.password);
       if (!isPasswordMatch) {
         req.flash('error', 'The password you have entered is a complete nonesense, please correct it before you try loging in again or change it if you forgot');
         return res.redirect('/login');
       }
      if (user && (await bcrypt.compare(password, user.password))) {
      const token = jwt.sign({userId: user._id, subscriptionExpiry: user.subscriptionExpiry, email: user.email, role: user.role}, 'jwtSecret', {
        expiresIn: '1h',
      });
      req.session.token = token;
      req.flash('welcome', 'Welcome');
      res.redirect('/profile');
    }
  } catch (error) {
    req.flash('error', 'there is problem loging in sorry for that🙆‍🙏');
    res.redirect('/login');
  }
};


// ***logout route***
exports.logout = async (req, res, next) => {
  try {
    req.session.token = null;
    req.flash('logout', 'You have logout successfully Bye Bye 🙋‍ see you soon.');
    res.redirect('/');
  } catch (error) {
    req.flash('error', 'there is problem while loging out');
    res.redirect('/');
  }
};


// ***forgotpassword route***
exports.forgotpassword = async (req, res, next) => {
  const { email } = req.body;
  try {
      // find email in the database
    const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
    if (!user) {
      req.flash('error', 'The email is not registered');
      return res.redirect('/forgotpassword');
    }
    // Generate a password reset token
    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.PRIVATE_KEY, {
      expiresIn: '1h',
    });
    // send token to the email above
    const resetUrl = `http://localhost:3000/resetpassword?token=${token}`;
    // send token to the email above
    await transporter.sendMail({
      to: req.body.email,
      from: 'awanmabur2@gmail.com',
      subject: 'Reset Password',
      html: `Click <a href="${resetUrl}">here</a> to reset your password.`,
    });
    // sending alert to the above person
    req.flash('success', 'we have just sent a token to your email in order to change your password, please check your email address');
    return res.redirect('/notification');
  } catch (err) {
    req.flash('error', 'there is problem resetting your password please try it later');
    return res.redirect('/forgotpassword');
  }
};


// ***forgotpassword route***
exports.resetpassword = async (req, res, next) => {
  try {
    const { token, password, confirmPassword } = req.body;
    // checking password and confirmPassword match
    if (password !== confirmPassword) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect('/resetpassword');
    }
    // checking TokenExpired
    if (isTokenExpired(token)) {
      req.flash('error', 'token has expired please get another token');
      return res.redirect('/forgotpassword');
    } else {
    // Verify the token
    const decodedToken = jwt.verify(token, process.env.PRIVATE_KEY);
    // Find the user associated with the token
    const user = await User.findById(decodedToken.userId);
    if (!user) {
      req.flash('error', 'sorry we do not have this email in our database');
      return res.redirect('/forgotpassword');
    }
    // Find the user email associated with the token
    const email = user.email;
    // Generate a salt and hash the new password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    // Update the user's password in the database
    await User.updateOne({ email }, { password: hashedPassword });
    // sending alert to the above person
    req.flash('success', 'Password reset successful You can now login with your new password');
    return res.redirect("/login");
    }
  } catch (error) {
    req.flash('error', 'there is problem resetting your password please try it later');
    return res.redirect('/resetpassword');
  }
};
