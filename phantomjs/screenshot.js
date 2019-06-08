var page = require('webpage').create(),
    system = require('system'),
    url, output, width, height;

page.onResourceReceived = function(response) {
    valid = [200, 201, 301, 302]
    if(response.id == 1 && valid.indexOf(response.status) == -1 ){
        console.log('Received a non-200 OK response, got: ', response.status);
        phantom.exit(1);
    }
}

address = system.args[1];
output = system.args[2];
width = parseInt(system.args[3]);
height = parseInt(system.args[4]);
timeout = system.args[5];

console.log("Args: ", system.args);
console.log("Screenshotting: ", address, ", to: ", output);

page.viewportSize = { width: width, height: height };
console.log("Viewport: ", JSON.stringify(page.viewportSize));

page.open(address, function (status) {
  if (status !== 'success') {
    console.log('Unable to load the address!');
    phantom.exit();
  } else {
    // Scroll to bottom of page, so all resources are triggered for downloading
    window.setInterval(function() {
      page.evaluate(function() {
        console.log('scrolling', window.document.body.scrollTop);
        window.document.body.scrollTop = window.document.body.scrollTop + 1024;
        /* scale the whole body */
        // window.document.body.style.webkitTransform = "scale(2)";
        // window.document.body.style.webkitTransformOrigin = "0% 0%";
        /* fix the body width that overflows out of the viewport */
        // window.document.body.style.width = "50%";
      });
    }, 255);

    // scroll back to top for consistency, right in time (sometimes)
    // logo's dissapear when scrolling down
    window.setTimeout(function() {
      page.evaluate(function() {
        window.document.body.scrollTop = 0;
      });
    }, timeout - 5);

    // after the timeout, save the screenbuffer to file
    window.setTimeout(function() {
      page.clipRect = { width: width, height: height };
      page.zoomFactor = 0.50;
      page.render(output);
      phantom.exit();
    }, timeout);
  }
});
//
// var page = require('webpage').create();
// page.open('http://github.com/', function() {
//   page.render('github.png');
//   phantom.exit();
// });
