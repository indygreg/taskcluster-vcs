import run from './run';
import render from 'json-templater/string';
import fs from 'mz/fs';
import fsPath from 'path';
import denodeify from 'denodeify';
import mkdirp_ from 'mkdirp';
import assert from 'assert';
import ms from 'ms';

import { Index, Queue } from 'taskcluster-client';

let mkdirp = denodeify(mkdirp_);

/**
The logic if how artifacts are found and stored is kept here and utilized by
anything that needs to download an artifact (and find it via the index) or
utilize one cached locally.
*/
export default class Artifacts {

  /**
  @param {Object} config leaf for example the "repoCache" section from default_config.yml.
  @param {Object} [queue] taskcluster queue.
  @param {Object} [index] taskcluster queue.
  */
  constructor(config, queue, index) {
    this.config = config;
    this.queue = queue || new Queue();
    this.index = index || new Index();
  }

  nameToArtifact(name) {
    return `public/${name}.tar.gz`;
  }

  /**
  Find the path on disk where artifact would be kept.
  */
  lookupLocal(name) {
    let root = render(this.config.cacheDir, { env: process.env });
    return fsPath.join(
      root,
      render(this.config.cacheName, { name })
    );
  }

  /**
  Find an artifact via the index and return a url if found.
  */
  async lookupRemote(namespace, artifact) {
    let task;
    try {
      task = await this.index.findTask(namespace);
    } catch (e) {
      // 404 will throw so validate before returning null...
      if (e.code && e.code != 404) throw e;
      return null;
    }

    return this.queue.buildUrl(
      this.queue.getLatestArtifact, task.taskId, artifact
    );
  }

  /**
  Find and extract an artifact if possible returns true if one is
  found/extracted false otherwise...
  */
  async useIfAvailable(name, namespace, dest) {
    let localPath = this.lookupLocal(name);
    if (await fs.exists(localPath)) {
      // Attempt to extract from local tar if this fails then allow remote
      // download to be attempted...
      try {
        await this.extract(localPath, dest);
        return true;
      } catch (e) {
        console.error(
          'Error extracting tar re-downloading',
          localPath,
          e.stack
        );
        // Destroy cache...
        await run(`rm -Rf ${localPath} ${dest}`);
        // Intentionally falling through...
      }
    }

    let remoteUrl =
      await this.lookupRemote(namespace, this.nameToArtifact(name));

    if (!remoteUrl) {
      return false;
    }

    await this.download(remoteUrl, localPath);
    await this.extract(localPath, dest);

    return true;
  }

  /**
  Download url to localPath ensuring directories exist along the way.
  */
  async download(remoteUrl, localPath) {
    // Ensure directory exists...
    let dirname = fsPath.dirname(localPath);
    await mkdirp(dirname);
    let cmd = render(this.config.get, {
      url: remoteUrl,
      dest: localPath
    });
    await run(cmd, { retries: 20 });
  }

  async upload(source, url) {
    assert(await fs.exists(source), `${source} must exist`);
    let cmd = render(this.config.uploadTar, {
      source, url
    });
    await run(cmd, { retries: 10 });
  }

  /**
  Extract the tars!
  */
  async extract(source, dest) {
    await mkdirp(dest);
    assert(await fs.exists(source), `${source} must exist to extract...`);
    assert(dest, 'must pass dest...');
    await run(render(this.config.extract, {
      source,
      dest
    }));
  }

  /**
  Note: This method _requires_ you to have created the local artifact first.
  */
  async indexAndUploadArtifact(name, namespace, options) {
    let localPath = this.lookupLocal(name);
    assert(
      await fs.exists(localPath),
      `Artifact (${localPath}) must exist locally first did you call createLocalArtifact?`
    );

    options = Object.assign({
      taskId: process.env.TASK_ID,
      runId: process.env.RUN_ID,
      expires: new Date(Date.now() + ms('30 days')),
      rank: Date.now()
    }, options);

    assert(options.taskId, 'must pass taskId');
    assert(options.runId, 'must pass runId');

    let artifact = await this.queue.createArtifact(
      options.taskId,
      options.runId,
      this.nameToArtifact(name),
      {
        storageType: 's3',
        expires: options.expires,
        contentType: 'application/x-tar'
      }
    );

    await this.upload(localPath, artifact.putUrl);

    await this.index.insertTask(namespace, {
      taskId: options.taskId,
      // Note: While we _can_ determine a few useful different ways of ranking a
      // single repository (number of commits, last date of commit, etc...) using
      // a simple Date.now + a periodic caching system is likely to yield better
      // results with similar amount of churn...
      rank: options.rank,
      data: {},
      expires: options.expires
    });
  }

  /**
  Given the name of an artifact create it locally (compressing files).

  @param {String} name of artifact.
  @param {String} cwd where to run compression (important for tar paths).
  @param {String} ...files to compress.
  @return {String} path to artifact.
  */
  async createLocalArtifact(name, cwd, ...files) {
    let path = this.lookupLocal(name);
    await mkdirp(fsPath.dirname(path));

    await Promise.all(files.map(async (file) => {
      let path = fsPath.join(cwd, file);
      assert(await fs.exists(path), `Missign file in artifact path (${path})`);
    }));

    let cmd = render(this.config.compress, {
      source: files.join(' '),
      dest: path
    });

    await run(cmd, { cwd });
    return path;
  }
}
