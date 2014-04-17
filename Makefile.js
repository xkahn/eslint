/**
 * @fileoverview Build file
 * @author nzakas
 */
/*global target, exec, echo, find, cat, rm, mv*/

"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

require("shelljs/make");

var path = require("path"),
    dateformat = require("dateformat"),
    nodeCLI = require("shelljs-nodecli"),
    os = require("os");

//------------------------------------------------------------------------------
// Settings
//------------------------------------------------------------------------------

/*
 * A little bit fuzzy. My computer has a first OS speed of 3093 and the perf test
 * always completes in < 2000ms. However, Travis is less predictable due to
 * multiple different VM types. So I'm fudging this for now in the hopes that it
 * at least provides some sort of useful signal.
 */
var PERF_MULTIPLIER = 7.5e6;

//------------------------------------------------------------------------------
// Data
//------------------------------------------------------------------------------

var NODE = "node ", // intentional extra space
    NODE_MODULES = "./node_modules/",
    TEMP_DIR = "./tmp/",
    BUILD_DIR = "./build/",

    // Utilities - intentional extra space at the end of each string
    MOCHA = NODE_MODULES + "mocha/bin/_mocha ",
    ESLINT = NODE + " bin/eslint.js ",

    // Files
    JS_FILES = find("lib/").filter(fileType("js")).join(" "),
    JSON_FILES = find("conf/").filter(fileType("json")).join(" ") + " .eslintrc",
    TEST_FILES = find("tests/lib/").filter(fileType("js")).join(" ");

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

/**
 * Generates a function that matches files with a particular extension.
 * @param {string} extension The file extension (i.e. "js")
 * @returns {Function} The function to pass into a filter method.
 * @private
 */
function fileType(extension) {
    return function(filename) {
        return filename.substring(filename.lastIndexOf(".") + 1) === extension;
    };
}

/**
 * Generates a static file that includes each rule by name rather than dynamically
 * looking up based on directory. This is used for the browser version of ESLint.
 * @param {string} basedir The directory in which to look for code.
 * @returns {void}
 */
function generateRulesIndex(basedir) {
    var output = "module.exports = function() {\n";
    output += "    var rules = Object.create(null);\n";

    find(basedir + "rules/").filter(fileType("js")).forEach(function(filename) {
        var basename = path.basename(filename, ".js");
        output += "    rules[\"" + basename + "\"] = require(\"./rules/" + basename + "\");\n";
    });

    output += "\n    return rules;\n};";
    output.to(basedir + "load-rules.js");
}

/**
 * Creates a release version tag and pushes to origin.
 * @param {string} type The type of release to do (patch, minor, major)
 * @returns {void}
 */
function release(type) {
    target.test();
    exec("npm version " + type);
    target.changelog();
    exec("git push origin master --tags");
    exec("npm publish");
    target.gensite();
}

//------------------------------------------------------------------------------
// Tasks
//------------------------------------------------------------------------------

target.all = function() {
    target.test();
};

target.lint = function() {
    echo("Validating JSON Files");
    nodeCLI.exec("jsonlint", "-q -c", JSON_FILES);

    echo("Validating JavaScript files");
    exec(ESLINT + JS_FILES);

    echo("Validating JavaScript test files");
    exec(ESLINT + TEST_FILES);
};

target.test = function() {
    target.lint();
    target.checkRuleFiles();

    nodeCLI.exec("istanbul", "cover", MOCHA, "-- -c", TEST_FILES);
    // exec(ISTANBUL + " cover " + MOCHA + "-- -c " + TEST_FILES);
    nodeCLI.exec("istanbul", "check-coverage", "--statement 99 --branch 98 --function 99 --lines 99");
    // exec(ISTANBUL + "check-coverage --statement 99 --branch 98 --function 99 --lines 99");

    target.browserify();
    nodeCLI.exec("mocha-phantomjs", "-R dot", "tests/tests.htm");
};

target.docs = function() {
    echo("Generating documentation");
    nodeCLI.exec("jsdoc", "-d jsdoc lib");
    echo("Documentation has been output to /jsdoc");
};

target.gensite = function() {

    echo("Generating eslint.org");
    var docsDir = "../eslint.github.io/docs",
        currentDir = pwd();

    rm("-r", docsDir);
    mkdir(docsDir);
    cp("-rf", "docs/*", docsDir);

    find(docsDir).forEach(function(filename) {
        if (test("-f", filename)) {
            var text = cat(filename);
            text = "---\ntitle: ESLint\nlayout: doc\n---\n<!-- Note: No pull requests accepted for this file. See README.md in the root directory for details. -->\n" + text;
            text.replace(/.md\)/g, ".html)").replace("README.html", "index.html").to(filename.replace("README.md", "index.md"));
        }
    });

    cd(docsDir);
    exec("git add -A .");
    exec("git commit -m \"Autogenerated new docs at " + dateformat(new Date()) + "\"");
    exec("git fetch origin && git rebase origin/master");
    exec("git push origin master");
    cd(currentDir);

};

target.browserify = function() {

    // 1. create temp and build directory
    if (!test("-d", TEMP_DIR)) {
        mkdir(TEMP_DIR);
    }

    if (!test("-d", BUILD_DIR)) {
        mkdir(BUILD_DIR);
    }

    // 2. copy files into temp directory
    cp("-r", "lib/*", TEMP_DIR);

    // 3. delete the load-rules.js file
    rm(TEMP_DIR + "load-rules.js");

    // 4. create new load-rule.js with hardcoded requires
    generateRulesIndex(TEMP_DIR);

    // 5. browserify the temp directory
    nodeCLI.exec("browserify", TEMP_DIR + "eslint.js", "-o", BUILD_DIR + "eslint.js", "-s eslint")
    // exec(BROWSERIFY + TEMP_DIR + "eslint.js -o " + BUILD_DIR + "eslint.js -s eslint");

    // 6. remove temp directory
    rm("-r", TEMP_DIR);
};

target.changelog = function() {

    // get most recent two tags
    var tags = exec("git tag", { silent: true }).output.trim().split(/\s/g),
        rangeTags = tags.slice(tags.length - 2),
        now = new Date(),
        timestamp = dateformat(now, "mmmm d, yyyy");

    // output header
    (rangeTags[1] + " - " + timestamp + "\n").to("CHANGELOG.tmp");

    // get log statements
    var logs = exec("git log --pretty=format:\"* %s (%an)\" " + rangeTags.join(".."), {silent:true}).output.split(/\n/g);
    logs = logs.filter(function(line) {
        return line.indexOf("Merge pull request") === -1 && line.indexOf("Merge branch") === -1;
    });
    logs.push(""); // to create empty lines
    logs.unshift("");

    // output log statements
    logs.join("\n").toEnd("CHANGELOG.tmp");

    // switch-o change-o
    cat("CHANGELOG.tmp", "CHANGELOG.md").to("CHANGELOG.md.tmp");
    rm("CHANGELOG.tmp");
    rm("CHANGELOG.md");
    mv("CHANGELOG.md.tmp", "CHANGELOG.md");

    // add into commit
    exec("git add CHANGELOG.md");
    exec("git commit --amend --no-edit");

};

target.checkRuleFiles = function() {

    echo("Validating rules");

    var ruleFiles = find("lib/rules/").filter(fileType("js")),
        rulesIndexText = cat("docs/rules/README.md"),
        confRules = require("./conf/eslint.json").rules,
        errors = 0;

    ruleFiles.forEach(function(filename) {
        var basename = path.basename(filename, ".js");

        // check for docs
        if (!test("-f", "docs/rules/" + basename + ".md")) {
            console.error("Missing documentation for rule %s", basename);
            errors++;
        } else {

            // check for entry in docs index
            if (rulesIndexText.indexOf("(" + basename + ".md)") === -1) {
                console.error("Missing link to documentation for rule %s in index", basename);
                errors++;
            }
        }

        // check for default configuration
        if (!confRules.hasOwnProperty(basename)) {
            console.error("Missing default setting for %s in eslint.json", basename);
            errors++;
        }

        // check for tests
        if (!test("-f", "tests/lib/rules/" + basename + ".js")) {
            console.error("Missing tests for rule %s", basename);
            errors++;
        }

    });

    if (errors) {
        exit(1);
    }

};

target.perf = function() {
    var start = process.hrtime(),
        results = [],
        cpuSpeed = os.cpus()[0].speed,
        max = PERF_MULTIPLIER / cpuSpeed,
        cmd = ESLINT + "./tests/performance/jshint.js";

    echo("CPU Speed is %d with multiplier %d", cpuSpeed, PERF_MULTIPLIER);

    exec(cmd, { silent: true }, function() {
        var diff = process.hrtime(start),
            actual = (diff[0] * 1e9 + diff[1]) / 1000000,
            start2;

        results.push(actual);
        echo("Performance Run #1:  %dms (limit: %dms)", actual, max);
        start2 = process.hrtime();

        // Run 2

        exec(cmd, {silent: true}, function() {

            var diff = process.hrtime(start2),
                actual = (diff[0] * 1e9 + diff[1]) / 1000000,
                start3;

            results.push(actual);
            echo("Performance Run #2:  %dms (limit: %dms)", actual, max);
            start3 = process.hrtime();

            // Run 3

            exec(cmd, {silent: true}, function() {

                var diff = process.hrtime(start3),
                    actual = (diff[0] * 1e9 + diff[1]) / 1000000;

                results.push(actual);
                echo("Performance Run #3:  %dms (limit: %dms)", actual, max);

                results.sort(function(a, b) {
                    return a - b;
                });

                if (results[1] > max) {
                    echo("Performance budget exceeded: %dms (limit: %dms)", actual, max);
                    exit(1);
                } else {
                    echo("Performance budget ok:  %dms (limit: %dms)", actual, max);
                }

            });

        });




    });

};

target.patch = function() {
    release("patch");
};

target.minor = function() {
    release("minor");
};

target.major = function() {
    release("major");
};
