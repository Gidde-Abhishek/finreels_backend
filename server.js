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
const MEDIACONVERT_ROLE = process.env.MEDIACONVERT_ROLE;
const MEDIACONVERT_ENDPOINT = process.env.MEDIACONVERT_ENDPOINT;
const MEDIACONVERT_OUTPUT_BUCKET = process.env.MEDIACONVERT_OUTPUT_BUCKET;

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: 'ap-south-1'
});

const s3 = new AWS.S3();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const mediaConvert = new AWS.MediaConvert({ endpoint: MEDIACONVERT_ENDPOINT });
const TABLE_NAME = 'finreels';

// Fetch latest reels
app.get('/reels-latest', async (req, res) => {
    const params = {
        TableName: TABLE_NAME
    };

    try {
        const data = await dynamoDB.scan(params).promise();
        const reels = data.Items
            .sort((a, b) => b.timestamp - a.timestamp) // Sort by timestamp in descending order
            .map(item => ({
                reel_id: item.reel_id,
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

        // Create MediaConvert job
        const jobParams = {
            Role: MEDIACONVERT_ROLE,
            Settings: {
                Inputs: [{
                    FileInput: `s3://${S3_BUCKET}/${fileName}`,
                    VideoSelector: {
                        ColorSpace: 'FOLLOW'
                    },
                    AudioSelectors: {
                        'Audio Selector 1': {
                            DefaultSelection: 'DEFAULT'
                        }
                    }
                }],
                OutputGroups: [{
                    Name: 'Apple HLS',
                    OutputGroupSettings: {
                        Type: 'HLS_GROUP_SETTINGS',
                        HlsGroupSettings: {
                            SegmentLength: 10,
                            Destination: `s3://${MEDIACONVERT_OUTPUT_BUCKET}/reels/${stock_identifier}_${reel_id}/`
                        }
                    },
                    Outputs: [{
                        VideoDescription: {
                            CodecSettings: {
                                Codec: 'H_264',
                                H264Settings: {
                                    RateControlMode: 'QVBR',
                                    SceneChangeDetect: 'TRANSITION_DETECTION',
                                    QualityTuningLevel: 'SINGLE_PASS'
                                }
                            }
                        },
                        AudioDescriptions: [{
                            CodecSettings: {
                                Codec: 'AAC',
                                AacSettings: {
                                    Bitrate: 96000,
                                    CodingMode: 'CODING_MODE_2_0',
                                    SampleRate: 48000
                                }
                            }
                        }],
                        ContainerSettings: {
                            Container: 'M3U8',
                            M3u8Settings: {}
                        }
                    }]
                }]
            }
        };

        const job = await mediaConvert.createJob(jobParams).promise();

        const dbParams = {
            TableName: TABLE_NAME,
            Item: {
                stock_identifier,
                reel_id,
                s3_key: fileName,
                caption,
                likes: 0,
                likedBy: [],
                timestamp: Date.now(),
                jobId: job.Job.Id
            }
        };

        await dynamoDB.put(dbParams).promise();

        const reelData = {
            message: 'Reel featured successfully',
            media_url: `${CLOUDFRONT_URL}/reels/${stock_identifier}_${reel_id}/index.m3u8`
        };

        res.json(reelData);
    } catch (error) {
        res.status(500).json({ error: `Failed to feature reel: ${error.message}` });
    }
});

// Like a reel
app.post('/like-reel', async (req, res) => {
    const { stock_identifier, reel_id, client_id } = req.body;

    if (!stock_identifier || !reel_id || !client_id) {
        return res.status(400).json({ error: 'Stock Identifier, Reel ID, and Client ID are required' });
    }

    const getParams = {
        TableName: TABLE_NAME,
        Key: { stock_identifier, reel_id }
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
            Key: { stock_identifier, reel_id },
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
