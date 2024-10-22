const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');

const app = express();

// Database connection
mongoose.connect('mongodb://localhost/blog', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Create mongoose schema for posts
const Post = require('./models/post');

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, './public/uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage: storage });

// Set EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware to handle form data
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', async (req, res) => {
  try {
    const posts = await Post.find();
    res.render('index1', { posts });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.get('/posts/:id', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    res.render('post_detail', { post });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});


app.post('/create', upload.array('images', 5), async (req, res) => {
  try {
    const { title, content } = req.body;
    const images = req.files.map(file => file.filename);

    // 3. Check if an image with the same name already exists in the database
    const existingImage = await Post.findOne({ images:req.files.filename });

    if (existingImage) {
      return res.status(400).json({ error: 'Image with the same name already exists' });
    }

    const newPost = new Post({ title, content, images });
    await newPost.save();
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});



// // ***store report route***
// exports.store = async (req, res, next) => {
//   const { itemname, category, price, description } = req.body;
//   const images = req.files.map(file => file.filename);
//
//   // let image;
//   // if (req.file) {
//   //   image = req.file.filename;
//   // }
//
//   const token = req.session.token;
//   if (!token) {
//     req.flash('error', 'Your session has expired please login again.');
//     return res.redirect('/login');
//   }
//   // Verify JWT token
//   const decodedToken = jwt.verify(token, 'jwtSecret');
//   const userId = decodedToken.userId;
//   // Get user and account details
//   const user = await User.findById(userId);
//   const account = await User.findOne({ user });
//   const owner = req.user
//
// try {
//
//   if (req.fileValidationError) {
//     return res.status(400).json({ error: req.fileValidationError });
//   }
//   // Check the size of the uploaded image
//   if (req.files.size > 10 * 1024 * 1024) {
//     fs.unlinkSync(req.files.path);
//     req.flash('error', 'Image size exceeds the limit (2MB).')
//     return res.redirect('/create-item');
//   }
//   // Check if the image with the same filename exists in the database
//   const existingImage = await Item.findOne({ image:images });
//
//   if (existingImage) {
//     req.flash('error', 'Image already exists in the database')
//     return res.redirect('/create-item');
//   } else {
//     // If the image doesn't exist, save it to the database
//     const item = new Item({ user:userId, owner, images, itemname, price, category, description });
//     user.Items.push(item);
//     // save report
//     await Promise.all([item.save(), user.save()]);
//     console.log(images);
//     req.flash('success', 'You have successfully posted one item.');
//     res.redirect('/create-item');
// }
//   } catch (error) {
//     console.error(error);
//     req.flash('error', 'There is problem posting item, please try again later.');
//     res.redirect('/profile');
//   }
// };



// image1:image1,
// image1:image2,
// image1:image3,
// image1:image4,
// image1:image5,
// image2:image2,
// image2:image3,
// image2:image4,
// image2:image5,
// image3:image3,
// image3:image4,
// image3:image5,
// image4:image4,
// image4:image5,
// image5:image5,

//
// <!-- views/index.ejs -->
//
// <!DOCTYPE html>
// <html lang="en">
// <head>
//     <meta charset="UTF-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>Blog Website</title>
// </head>
// <body>
//     <h1>Welcome to the Blog</h1>
//     <form action="/create" method="POST" enctype="multipart/form-data">
//         <label for="title">Title:</label><br>
//         <input type="text" id="title" name="title" required><br>
//         <label for="content">Content:</label><br>
//         <textarea id="content" name="content" required></textarea><br>
//         <label for="images">Upload Images:</label><br>
//         <input type="file" id="images" name="images" multiple><br>
//         <button type="submit">Submit</button>
//     </form>
//     <hr>
//   <% posts.forEach((post, index) => { %>
//
//         <div>
//             <h2><%= post.title %></h2>
//             <p><%= post.content %></p>
//
//             <% post.images.forEach(image => { %>
//                 <img src="/uploads/<%= image %>" alt="Post Image" style="max-width: 300px;">
//             <% }); %>
//         </div>
//         <hr>
//     <% }); %>
// </body>
// </html>


// if (image1) fs.unlinkSync(path.join(__dirname, '../public/uploads', image1));
// if (image2) fs.unlinkSync(path.join(__dirname, '../public/uploads', image2));
// if (image3) fs.unlinkSync(path.join(__dirname, '../public/uploads', image3));

// if (image1 === image2 || image1 === image3 || image2 === image3) {
//     return res.send('Error: Images should be unique.');
//   }
//
// const existingImages = await Item.findOne({
//    $or: [{ image1: { $exists: true } }, { image2: { $exists: true } }, { image3: { $exists: true } }]
//  });
//
//  // If an image already exists, prevent the upload
//  if (existingImages) {
//    console.log('An image already exists in the database. Upload prevented.');
//    return { success: false, message: 'An image already exists in the database. Upload prevented.' };
//  }
