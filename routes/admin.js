require("dotenv").config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const jwtSecret = process.env.PRIVATE_KEY;
const User = require('../models/User');

//calling the middlewares
const {admin} = require("../middlewares/admin");

const superAdmin = require("../controllers/admin");

const {requireLogin} = require("../middlewares/loginrequest");

router.get('/users', admin, superAdmin.users);

router.get('/subscription', (req, res) => res.render("admin/subscription"));

router.post('/deleteUser', requireLogin, superAdmin.deleteUser);

router.post('/suspendUser', requireLogin, superAdmin.suspendUser);

router.post('/unsuspendUser', requireLogin, superAdmin.unsuspendUser);

router.post('/monthly', admin, superAdmin.monthlySubscription);

router.post('/quarterly', admin, superAdmin.quarterlySubscription);

router.post('/annually', admin, superAdmin.annuallySubscription);

router.post('/monthlycancellation', admin, superAdmin.monthlyCancellation);

router.post('/quarterlycancellation', admin, superAdmin.quarterlyCancellation);

router.post('/annuallycancellation', admin, superAdmin.annuallyCancellation);

router.get('/search', admin, superAdmin.search);

module.exports = router;
