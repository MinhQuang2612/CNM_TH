// Import các thư viện cần thiết
const express = require('express');
const path = require('path');
const app = express();

// Import dotenv để đọc file .env
require('dotenv').config();

// Import uuid để tạo tên file duy nhất
const { v4: uuid } = require('uuid');

// Import multer để xử lý upload file
const multer = require('multer');

// Import AWS SDK v3 cho S3
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

// Lấy các biến từ file .env
const port = process.env.PORT;
const dynamoRegion = process.env.REGION;
const s3Region = process.env.S3_REGION;
const accessKeyId = process.env.ACCESS_KEY_ID;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;
const tableName = process.env.TABLE_NAME;
const s3Bucket = process.env.S3_BUCKET;
const cloudFrontUrl = process.env.CLOUDFRONT_URL;

// Middleware để parse JSON và form
app.use(express.json({ extend: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('./views'));
app.set('view engine', 'ejs');
app.set('views', './views');

// Config AWS DynamoDB với SDK v3
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { 
  DynamoDBDocumentClient, 
  ScanCommand, 
  PutCommand, 
  DeleteCommand,
  GetCommand,
  UpdateCommand 
} = require('@aws-sdk/lib-dynamodb');

// Khởi tạo DynamoDB client
const client = new DynamoDBClient({
  region: dynamoRegion,
  credentials: {
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
  },
});

// Khởi tạo DocumentClient
const docClient = DynamoDBDocumentClient.from(client);

// Config AWS S3 client
const s3Client = new S3Client({
  region: s3Region,
  credentials: {
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
  },
});

// Cấu hình multer để xử lý upload file
const storage = multer.memoryStorage({
  destination(req, file, callback) {
    callback(null, '');
  },
});

function checkFileType(file, cb) {
  const fileTypes = /jpeg|jpg|png|gif/;
  const extname = fileTypes.test(path.extname(file.originalname).toLowerCase());
  const mimeType = fileTypes.test(file.mimetype);

  if (extname && mimeType) {
    return cb(null, true);
  }
  return cb('Error: Image Only!');
}

const upload = multer({
  storage,
  limits: { fileSize: 5000000 }, // 5MB
  fileFilter(req, file, cb) {
    checkFileType(file, cb);
  },
});

// Route để hiển thị danh sách sản phẩm
app.get('/', async (req, res) => {
  const params = {
    TableName: tableName,
  };

  try {
    const command = new ScanCommand(params);
    const data = await docClient.send(command);
    
    // Kiểm tra từng sản phẩm có ảnh tồn tại trong S3 không
    for (const item of data.Items) {
      if (item.image_url) {
        const fileKey = item.image_url.replace(`${cloudFrontUrl}/`, '');
        
        try {
          // Kiểm tra file có tồn tại trong S3
          await s3Client.send(new HeadObjectCommand({
            Bucket: s3Bucket,
            Key: fileKey
          }));
          // Nếu không có lỗi, file tồn tại
        } catch (error) {
          if (error.$metadata && error.$metadata.httpStatusCode === 404) {
            // File không tồn tại, cập nhật DynamoDB để xoá URL
            const updateParams = {
              TableName: tableName,
              Key: {
                ma_sp: item.ma_sp
              },
              UpdateExpression: "set image_url = :img",
              ExpressionAttributeValues: {
                ":img": ""
              }
            };
            await docClient.send(new UpdateCommand(updateParams));
            item.image_url = ""; // Cập nhật dữ liệu hiện tại
          }
        }
      }
    }
    
    return res.render('index', { sanPhams: data.Items });
  } catch (err) {
    console.error('Error scanning DynamoDB:', err);
    res.send('Internal Server Error');
  }
});

// Route để thêm sản phẩm
app.post('/', upload.single('image'), async (req, res) => {
  const { ma_sp, ten_sp, so_luong } = req.body;
  const file = req.file;

  // Kiểm tra xem ma_sp có tồn tại không
  if (!ma_sp) {
    return res.status(400).send('Missing ma_sp');
  }

  let imageUrl = '';
  if (file) {
    const fileType = file.mimetype.split('/')[1];
    const filePath = `${uuid()}.${fileType}`; // Tạo tên file duy nhất

    const params = {
      Bucket: s3Bucket,
      Key: filePath,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: 'public-read', // Đảm bảo file công khai
    };

    try {
      const command = new PutObjectCommand(params);
      await s3Client.send(command);
      imageUrl = `${cloudFrontUrl}/${filePath}`; // URL công khai qua CloudFront
    } catch (err) {
      console.error('Error uploading to S3:', err);
      return res.send('Internal Server Error');
    }
  }

  const newItem = {
    TableName: tableName,
    Item: {
      ma_sp: String(ma_sp),
      ten_sp: ten_sp || 'Không có tên',
      so_luong: Number(so_luong) || 0,
      image_url: imageUrl || '', // Lưu URL hình ảnh vào DynamoDB
    },
  };

  try {
    const command = new PutCommand(newItem);
    await docClient.send(command);
    return res.redirect('/');
  } catch (err) {
    console.error('Error putting item to DynamoDB:', err);
    return res.send('Internal Server Error');
  }
});

// Route để xóa sản phẩm
app.post('/delete', async (req, res) => {
  const ma_sp_list = req.body.ma_sp;

  if (!ma_sp_list) {
    return res.redirect('/');
  }

  const itemsToDelete = Array.isArray(ma_sp_list) ? ma_sp_list : [ma_sp_list];

  try {
    // Lấy thông tin các sản phẩm trước khi xóa
    const productPromises = itemsToDelete.map(ma_sp => {
      const command = new GetCommand({
        TableName: tableName,
        Key: {
          ma_sp: String(ma_sp)
        }
      });
      return docClient.send(command);
    });

    const productResults = await Promise.all(productPromises);
    
    // Xử lý xóa file từ S3
    const s3DeletePromises = [];
    
    productResults.forEach(result => {
      if (result.Item && result.Item.image_url) {
        // Lấy key từ URL CloudFront
        const fileKey = result.Item.image_url.replace(`${cloudFrontUrl}/`, '');
        
        if (fileKey) {
          const deleteParams = {
            Bucket: s3Bucket,
            Key: fileKey
          };
          
          const deleteCommand = new DeleteObjectCommand(deleteParams);
          s3DeletePromises.push(s3Client.send(deleteCommand));
        }
      }
    });
    
    // Thực hiện xóa file từ S3
    if (s3DeletePromises.length > 0) {
      await Promise.all(s3DeletePromises);
    }

    // Sau đó xóa các mục từ DynamoDB
    const dbDeletePromises = itemsToDelete.map(ma_sp => {
      const params = {
        TableName: tableName,
        Key: {
          ma_sp: String(ma_sp),
        },
      };
      const command = new DeleteCommand(params);
      return docClient.send(command);
    });

    await Promise.all(dbDeletePromises);
    return res.redirect('/');
  } catch (err) {
    console.error('Error deleting items:', err);
    res.send('Internal Server Error');
  }
});

// Khởi động server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});