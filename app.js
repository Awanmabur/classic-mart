require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const flash = require('connect-flash');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Define the Post model directly in this file
const postSchema = new mongoose.Schema({
  title: String,
  content: String,
  image1_id: String, // public_id for image1
  image2_id: String, // public_id for image2
  image3_id: String, // public_id for image3
});
const Post = mongoose.model('Post', postSchema);

// Set up EJS as the template engine
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
}));
app.use(flash());


// Middleware for flash messages
app.use(function (req, res, next) {
  res.locals.successMessage = req.flash('success');
  res.locals.welcomeMessage = req.flash('welcome');
  res.locals.errorMessage = req.flash('error');
  res.locals.logoutMessage = req.flash('logout');
  res.locals.warningMessage = req.flash('warning');
  next();
});
// Configure Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Pass Cloudinary instance to EJS
app.locals.cloudinary = cloudinary;

// Route to display the form and all posts
app.get('/', async (req, res) => {
  try {
    const posts = await Post.find({});
    res.render('index', { posts });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).send("Error fetching posts");
  }
});

const sharp = require('sharp');

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB in bytes

// Route to handle creating a new post with images
app.post('/create', upload.fields([{ name: 'image1' }, { name: 'image2' }, { name: 'image3' }]), async (req, res) => {
  try {
    const { title, content } = req.body;

    // Validate file sizes
    const files = req.files;
    if (!files) {
      req.flash('error', 'No images uploaded.');
      return res.redirect('/');
    }

    for (const field of ['image1', 'image2', 'image3']) {
      if (files[field] && files[field][0].size > MAX_FILE_SIZE) {
        req.flash('error', `File size for ${field} exceeds 2MB.`);
        return res.redirect('/');
      }
    }

    // Compress and upload each image
    const uploadedImages = await Promise.all(
      ['image1', 'image2', 'image3'].map(async (field) => {
        if (files[field]) {
          // Use Sharp to resize and compress the image
          const buffer = await sharp(files[field][0].buffer)
            .resize(800)
            .jpeg({ quality: 80 })
            .toBuffer();

          // Upload the compressed image to Cloudinary
          return new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream({ folder: 'classic_mart' }, (error, result) => {
              if (error) reject(error);
              else resolve(result.public_id);
            }).end(buffer);
          });
        }
      })
    );

    // Create and save a new post
    const post = new Post({
      title,
      content,
      image1_id: uploadedImages[0],
      image2_id: uploadedImages[1],
      image3_id: uploadedImages[2],
    });

    await post.save();
    res.redirect('/');
  } catch (error) {
    console.error("Error creating post:", error);
    req.flash('error', 'Error creating post');
    res.redirect('/');
  }
});

// Route to edit an existing post
app.post('/edit/:id', upload.fields([{ name: 'image1' }, { name: 'image2' }, { name: 'image3' }, { name: 'image4' }, { name: 'image5' }]), async (req, res) => {
  try {
    const { title, content } = req.body;
    const post = await Post.findById(req.params.id);

    // Update title and content
    post.title = title;
    post.content = content;

    // Validate file sizes
    const files = req.files;
    const imageFields = ['image1', 'image2', 'image3', 'image4', 'image5'];
    for (const field of imageFields) {
      if (files[field] && files[field][0].size > MAX_FILE_SIZE) {
        req.flash('error', `File size for ${field} exceeds 2MB.`);
        return res.redirect('/');
      }
    }

    // Update images if new ones are uploaded
    for (let i = 0; i < imageFields.length; i++) {
      const field = imageFields[i];
      if (files[field]) {
        // Delete the old image from Cloudinary
        if (post[`${field}_id`]) {
          await cloudinary.uploader.destroy(post[`${field}_id`]);
        }

        // Compress and upload the new image
        const buffer = await sharp(files[field][0].buffer)
          .resize(800)
          .jpeg({ quality: 80 })
          .toBuffer();

        // Upload the new image to Cloudinary
        const uploadedImage = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream({ folder: 'classic_mart' }, (error, result) => {
            if (error) reject(error);
            else resolve(result.public_id);
          }).end(buffer);
        });
        post[`${field}_id`] = uploadedImage; // Update the public_id with the new image
      }
    }

    await post.save();
    res.redirect('/');
  } catch (error) {
    console.error("Error editing post:", error);
    req.flash('error', 'Error editing post');
    res.redirect('/');
  }
});



// Route to delete a post and its associated images from Cloudinary
app.post('/delete/:id', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    // Collect all image public IDs to delete from Cloudinary
    const imageIds = [
      post.image1_id,
      post.image2_id,
      post.image3_id,
      post.image4_id,
      post.image5_id,
    ].filter(id => id); // Filter out any null values

    // Delete images from Cloudinary
    await Promise.all(imageIds.map(id => {
      return cloudinary.uploader.destroy(id);
    }));

    // Now delete the post from the database
    await Post.findByIdAndDelete(req.params.id);
    res.redirect('/');
  } catch (error) {
    console.error("Error deleting post:", error);
    req.flash('error', 'Error deleting post');
    res.redirect('/');
  }
});


// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});



















// const express = require('express');
// const mongoose = require('mongoose');
// const multer = require('multer');
// const path = require('path');
//
// const app = express();
//
// // Database connection
// mongoose.connect('mongodb://localhost/blog', {
//   useNewUrlParser: true,
//   useUnifiedTopology: true,
// });
//
// // Create mongoose schema for posts
// const Post = require('./models/post');
//
// // Set up multer for file uploads
// const storage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     cb(null, './public/uploads/');
//   },
//   filename: function (req, file, cb) {
//     cb(null, Date.now() + '-' + file.originalname);
//   },
// });
// const upload = multer({ storage: storage });
//
// // Set EJS as the view engine
// app.set('view engine', 'ejs');
// app.set('views', path.join(__dirname, 'views'));
//
// // Middleware to handle form data
// app.use(express.urlencoded({ extended: true }));
// app.use(express.static(path.join(__dirname, 'public')));
//
// // Routes
// app.get('/', async (req, res) => {
//   try {
//     const posts = await Post.find();
//     res.render('index1', { posts });
//   } catch (err) {
//     console.error(err);
//     res.status(500).send('Server Error');
//   }
// });
//
// app.get('/posts/:id', async (req, res) => {
//   try {
//     const post = await Post.findById(req.params.id);
//     res.render('post_detail', { post });
//   } catch (err) {
//     console.error(err);
//     res.status(500).send('Server Error');
//   }
// });
//
//
// app.post('/create', upload.array('images', 5), async (req, res) => {
//   try {
//     const { title, content } = req.body;
//     const images = req.files.map(file => file.filename);
//
//     // 3. Check if an image with the same name already exists in the database
//     const existingImage = await Post.findOne({ images:req.files.filename });
//
//     if (existingImage) {
//       return res.status(400).json({ error: 'Image with the same name already exists' });
//     }
//
//     const newPost = new Post({ title, content, images });
//     await newPost.save();
//     res.redirect('/');
//   } catch (err) {
//     console.error(err);
//     res.status(500).send('Server Error');
//   }
// });
//
// // Start server
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });



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
