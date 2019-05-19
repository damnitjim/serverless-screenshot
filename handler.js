const exec = require('child_process').exec;
const crypto = require('crypto');
const fs = require('fs');
const AWS = require('aws-sdk');
const validUrl = require('valid-url');
const sharp = require('sharp');
const stream = require('stream');

// overall constants
const screenWidth = 1280;
const screenHeight = 1024;
const s3 = new AWS.S3();

// create the read stream abstraction for downloading data from S3
const readStreamFromS3 = ({ Bucket, Key }) => {
  console.log(`Getting S3 Object bucket ${Bucket} with key ${Key}`);
  return s3.getObject({ Bucket, Key }).createReadStream();
};
// create the write stream abstraction for uploading data to S3
const writeStreamToS3 = ({ Bucket, Key, WebsiteRedirectLocation }) => {
  console.log(`Writing to S3 Object bucket ${Bucket} with key ${Key}`);
  const pass = new stream.PassThrough();
  return {
    writeStream: pass,
    uploadFinished: s3.upload({
      ACL: 'public-read',
      Body: pass,
      Bucket,
      ContentType: 'image/png',
      Key,
      WebsiteRedirectLocation,
    }).promise(),
  };
};

// sharp resize stream
const streamToSharp = ({ width, height }) => {
  console.log('Resizing image with Sharp!');
  return sharp()
    .sequentialRead()
    .resize(width, height)
    .toFormat('png');
};

// screenshot the given url
module.exports.take_screenshot = (event, context, cb) => {
  console.log(JSON.stringify(event));

  const targetUrl = event.queryStringParameters.url;
  const timeout = event.stageVariables.screenshotTimeout;

  // check if the given url is valid
  if (!validUrl.isUri(targetUrl)) {
    cb(`422, please provide a valid url, not: ${targetUrl}`);
    return false;
  }

  const targetBucket = event.stageVariables.bucketName;
  const targetHash = crypto.createHash('md5').update(targetUrl).digest('hex');
  const targetFilename = `${targetHash}/original.png`;
  console.log(`Snapshotting ${targetUrl} to s3://${targetBucket}/${targetFilename}`);

  // build the cmd for phantom to render the url
  const cmd = `./phantomjs/phantomjs_linux-x86_64 --debug=yes --ignore-ssl-errors=true ./phantomjs/screenshot.js ${targetUrl} /tmp/${targetHash}.png ${screenWidth} ${screenHeight} ${timeout}`; // eslint-disable-line max-len
  // const cmd =`./phantomjs/phantomjs_osx          --debug=yes --ignore-ssl-errors=true ./phantomjs/screenshot.js ${targetUrl} /tmp/${targetHash}.png ${screenWidth} ${screenHeight} ${timeout}`;
  console.log(cmd);

  // run the phantomjs command
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      // the command failed (non-zero), fail the entire call
      console.warn(`exec error: ${error}`, stdout, stderr);
      cb(`422, please try again ${error}`);
    } else {
      // snapshotting succeeded, let's upload to S3
      // read the file into buffer (perhaps make this async?)
      const fileBuffer = fs.readFileSync(`/tmp/${targetHash}.png`);

      // upload the file
      s3.putObject({
        ACL: 'public-read',
        Key: targetFilename,
        Body: fileBuffer,
        Bucket: targetBucket,
        WebsiteRedirectLocation: targetUrl,
        ContentType: 'image/png',
      }, (err) => {
        if (err) {
          console.warn(err);
          cb(err);
        } else {
          // console.info(stderr);
          // console.info(stdout);
          cb(null, {
            hash: targetHash,
            key: `${targetFilename}`,
            bucket: targetBucket,
            url: `${event.stageVariables.endpoint}${targetFilename}`,
          });
        }
        return;
      });
    }
  });
};


// gives a list of urls for the given snapshotted url
module.exports.list_screenshots = (event, context, cb) => {
  console.log(JSON.stringify(event));

  const targetUrl = event.query.url;
  // check if the given url is valid
  if (!validUrl.isUri(targetUrl)) {
    cb(`422, please provide a valid url, not: ${targetUrl}`);
    return false;
  }

  const targetHash = crypto.createHash('md5').update(targetUrl).digest('hex');
  const targetBucket = event.stageVariables.bucketName;
  const targetPath = `${targetHash}/`;

  s3.listObjects({
    Bucket: targetBucket,
    Prefix: targetPath,
    EncodingType: 'url',
  }, (err, data) => {
    if (err) {
      cb(err);
    } else {
      const urls = {};
      // for each key, get the image width and add it to the output object
      data.Contents.forEach((content) => {
        const parts = content.Key.split('/');
        const size = parts.pop().split('.')[0];
        urls[size] = `${event.stageVariables.endpoint}${content.Key}`;
      });
      cb(null, urls);
    }
    return;
  });
};

module.exports.create_thumbnails = (event, context, cb) => {
  console.log(JSON.stringify(event));

  // define all the thumbnails that we want
  // const widths = {
  //   '320x240': `-crop ${screenWidth}x${screenHeight}+0x0 -thumbnail 320x240`,
  //   '640x480': `-crop ${screenWidth}x${screenHeight}+0x0 -thumbnail 640x480`,
  //   '800x600': `-crop ${screenWidth}x${screenHeight}+0x0 -thumbnail 800x600`,
  //   '1024x768': `-crop ${screenWidth}x${screenHeight}+0x0 -thumbnail 1024x768`,
  //   100: '-thumbnail 100x',
  //   200: '-thumbnail 200x',
  //   320: '-thumbnail 320x',
  //   400: '-thumbnail 400x',
  //   640: '-thumbnail 640x',
  //   800: '-thumbnail 800x',
  //   1024: '-thumbnail 1024x',
  // };
  const image_resizes = {
    '320x240': {
      width: 320,
      height: 240,
    },
    '640x480': {
      width: 640,
      height: 480,
    },
    '800x600': {
      width: 800,
      height: 600,
    },
    '1024x768': {
      width: 1024,
      height: 768,
    },
  };
  // const image_thumbnails = {
  //   100: '-thumbnail 100x',
  //   200: '-thumbnail 200x',
  //   320: '-thumbnail 320x',
  //   400: '-thumbnail 400x',
  //   640: '-thumbnail 640x',
  //   800: '-thumbnail 800x',
  //   1024: '-thumbnail 1024x',
  // };
  const record = event.Records[0];

  // we only want to deal with originals
  if (record.s3.object.key.indexOf('original.png') === -1) {
    console.warn('Not an original, skipping');
    cb('Not an original, skipping');
    return false;
  }

  // get the prefix, and get the hash
  const prefix = record.s3.object.key.split('/')[0];

  Object.keys(image_resizes).forEach((size) => {
    try {
      // create the read and write streams from and to S3 and the Sharp resize stream
      const readStream = readStreamFromS3({
        Bucket: record.s3.bucket.name,
        Key: record.s3.object.key,
      });
      const resizeStream = streamToSharp({
        width: image_resizes[size].width,
        height: image_resizes[size].height,
      });
      const { writeStream, uploadFinished } = writeStreamToS3({
        Bucket: record.s3.bucket.name,
        Key: `${prefix}/${size}.png`,
        WebsiteRedirectLocation: record.s3.WebsiteRedirectLocation,
      });

      // trigger the stream
      readStream
        .pipe(resizeStream)
        .pipe(writeStream);

      // wait for the stream to finish
      (async () => {
        await uploadFinished;
      })();
    } catch (err) {
      console.error(err);
      return {
        statusCode: '500',
        body: err.message,
      };
    }
  });
  return {
    statusCode: '200',
    body: 'Successfully resized images!',
  };
};
