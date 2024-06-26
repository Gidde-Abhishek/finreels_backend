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
const mediaConvert = new AWS.MediaConvert({ endpoint: process.env.MEDIACONVERT_ENDPOINT });
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

// Feature a reel by uploading video and converting it to HLS
app.post('/feature-reel', upload.single('file'), async (req, res) => {
    const { caption, stock_identifier } = req.body;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'Video file is required' });
    }

    const reel_id = uuidv4();
    const fileName = `reels/${stock_identifier}_${reel_id}.mp4`;

    try {
        // Upload the original MP4 file to S3
        const uploadParams = {
            Bucket: S3_BUCKET,
            Key: fileName,
            Body: file.buffer,
            ContentType: file.mimetype
        };

        await s3.upload(uploadParams).promise();

        // Create MediaConvert job settings
        const mediaConvertParams = {
            Role: process.env.MEDIACONVERT_ROLE,
            Settings: {
                OutputGroups: [
                    {
                        Name: "File Group",
                        OutputGroupSettings: {
                            Type: "HLS_GROUP_SETTINGS",
                            HlsGroupSettings: {
                                Destination: `s3://${process.env.MEDIACONVERT_OUTPUT_BUCKET}/`,
                                SegmentLength: 10,
                                MinSegmentLength: 0
                            }
                        },
                        Outputs: [
                            {
                                ContainerSettings: {
                                    Container: "M3U8"
                                },
                                VideoDescription: {
                                    CodecSettings: {
                                        Codec: "H_264",
                                        H264Settings: {
                                            MaxBitrate: 5000000,
                                            RateControlMode: "QVBR"
                                        }
                                    }
                                },
                                AudioDescriptions: [
                                    {
                                        AudioSourceName: "Audio Selector 1",
                                        CodecSettings: {
                                            Codec: "AAC",
                                            AacSettings: {
                                                Bitrate: 96000,
                                                CodingMode: "CODING_MODE_2_0",
                                                SampleRate: 48000
                                            }
                                        }
                                    }
                                ],
                                NameModifier: "_hls"
                            }
                        ]
                    }
                ],
                Inputs: [
                    {
                        FileInput: `s3://${S3_BUCKET}/${fileName}`,
                        AudioSelectors: {
                            "Audio Selector 1": {
                                DefaultSelection: "DEFAULT",
                                SelectorType: "TRACK",
                                Tracks: [1]
                            }
                        }
                    }
                ]
            }
        };

        const mediaConvertResponse = await mediaConvert.createJob(mediaConvertParams).promise();

        // Store the reel information in DynamoDB
        const dbParams = {
            TableName: TABLE_NAME,
            Item: {
                stock_identifier,
                reel_id,
                s3_key: fileName,
                caption,
                likes: 0,
                likedBy: [],
                timestamp: Date.now()
            }
        };

        await dynamoDB.put(dbParams).promise();

        const reelData = {
            message: 'Reel featured successfully',
            media_url: `${CLOUDFRONT_URL}/${fileName}`,
            mediaConvertJobId: mediaConvertResponse.Job.Id
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
