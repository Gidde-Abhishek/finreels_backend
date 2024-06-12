require('dotenv').config();
const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

const upload = multer({ storage: multer.memoryStorage() });

const S3_BUCKET = process.env.S3_BUCKET;
const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL;

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: 'ap-south-1'
});

const s3 = new AWS.S3();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = 'finreels';

// Fetch latest reels
app.get('/reels-latest', async (req, res) => {
    const params = {
        TableName: TABLE_NAME,
        ScanIndexForward: false // Sort in descending order
    };

    try {
        const data = await dynamoDB.scan(params).promise();
        const reels = data.Items.map(item => ({
            reel_id: item.reel_id, // Include reel_id in the response
            media_url: `${CLOUDFRONT_URL}/${item.s3_key}`,
            stock_identifier: item.stock_identifier,
            caption: item.caption,
            likes: item.likes || 0,
            likedBy: item.likedBy || []
        }));
        res.json(reels);
    } catch (error) {
        res.status(500).json({ error: `Failed to fetch latest reels: ${error.message}` });
    }
});


// Feature a reel by uploading video
app.post('/feature-reel', upload.single('file'), async (req, res) => {
    const { caption, stock_identifier } = req.body;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'Video file is required' });
    }

    const reel_id = uuidv4();
    const fileName = `reels/${stock_identifier}_${reel_id}.mp4`;

    try {
        const uploadParams = {
            Bucket: S3_BUCKET,
            Key: fileName,
            Body: file.buffer,
            ContentType: file.mimetype
        };

        await s3.upload(uploadParams).promise();

        const dbParams = {
            TableName: TABLE_NAME,
            Item: {
                stock_identifier,
                reel_id,
                s3_key: fileName,
                caption,
                likes:0,
                likedBy:[],
                timestamp: Date.now()
            }
        };

        await dynamoDB.put(dbParams).promise();

        const reelData = {
            message: 'Reel featured successfully',
            media_url: `${CLOUDFRONT_URL}/${fileName}`
        };

        res.json(reelData);
    } catch (error) {
        res.status(500).json({ error: `Failed to feature reel: ${error.message}` });
    }
});

// Like a reel
app.post('/like-reel', async (req, res) => {
    const { reel_id, client_id } = req.body;

    if (!reel_id || !client_id) {
        return res.status(400).json({ error: 'Reel ID and Client ID are required' });
    }

    const getParams = {
        TableName: TABLE_NAME,
        Key: { reel_id }
    };

    try {
        // Fetch the current reel data
        const data = await dynamoDB.get(getParams).promise();
        const reel = data.Item;

        if (!reel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        // Update the number of likes and likedBy list
        const likes = reel.likes ? reel.likes + 1 : 1;
        const likedBy = reel.likedBy ? [...reel.likedBy, client_id] : [client_id];

        const updateParams = {
            TableName: TABLE_NAME,
            Key: { reel_id },
            UpdateExpression: 'set likes = :likes, likedBy = :likedBy',
            ExpressionAttributeValues: {
                ':likes': likes,
                ':likedBy': likedBy
            },
            ReturnValues: 'UPDATED_NEW'
        };

        const result = await dynamoDB.update(updateParams).promise();

        res.json({ message: 'Reel liked successfully', updatedReel: result.Attributes });
    } catch (error) {
        res.status(500).json({ error: `Failed to like reel: ${error.message}` });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
    
