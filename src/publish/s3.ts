import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PublishError } from '../core/errors.js';

/**
 * Upload through the AWS CLI.
 *
 * Deliberately shells out to `aws s3 cp` rather than bundling an SDK. The CLI is
 * already present and already authenticated on the agents this runs on - an IAM
 * role, a shared profile, whatever the pipeline uses - and this tool never sees
 * a credential as a result. The cost is an undeclared binary dependency, so a
 * missing CLI has to fail with a message that says exactly that.
 *
 * Arguments are passed as an array, never as a shell string. A bucket or prefix
 * from a config file is not a trusted value, and a shell would happily read
 * `; rm -rf /` in one.
 */

const run = promisify(execFile);

export interface UploadOptions {
  /** Local file to upload. */
  file: string;
  /** Destination, e.g. `s3://bucket/prefix/report.zip`. */
  destination: string;
  /** Extra `aws s3 cp` arguments, e.g. `--sse`, `--acl`, `--storage-class`. */
  extraArgs?: readonly string[];
  /** Build the command and return it without running anything. */
  dryRun?: boolean;
}

export interface UploadResult {
  destination: string;
  /** The command, for logs and `--dry-run`. Never contains a credential. */
  command: string;
  uploaded: boolean;
}

export async function uploadToS3(options: UploadOptions): Promise<UploadResult> {
  const args = ['s3', 'cp', options.file, options.destination, ...(options.extraArgs ?? [])];
  const command = `aws ${args.join(' ')}`;

  if (options.dryRun) return { destination: options.destination, command, uploaded: false };

  try {
    await run('aws', args);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === 'ENOENT') {
      throw new PublishError(
        'The AWS CLI is not on PATH, and `drifter publish` uses it to upload. ' +
          'Install it (https://aws.amazon.com/cli/) or use --dry-run to produce the ' +
          'archive and the command without uploading.',
      );
    }
    // The CLI's own stderr says far more than an exit code - a wrong region, an
    // expired token, a bucket that does not exist all look identical otherwise.
    throw new PublishError(
      `\`${command}\` failed: ${(error.stderr ?? error.message ?? '').trim() || 'unknown error'}`,
      { cause },
    );
  }

  return { destination: options.destination, command, uploaded: true };
}

/**
 * Build the destination URI.
 *
 * Accepts either a bucket plus optional prefix, or a whole `s3://` URI, because
 * a pipeline usually already has one of those in a variable and should not have
 * to split it up.
 */
export function s3Destination(input: {
  bucket?: string | undefined;
  prefix?: string | undefined;
  uri?: string | undefined;
  fileName: string;
}): string {
  const base = input.uri ?? (input.bucket === undefined ? undefined : `s3://${input.bucket}`);
  if (base === undefined) {
    throw new PublishError(
      'No S3 destination. Pass --bucket (with optional --prefix), or --s3-uri, ' +
        'or set output.publish.bucket in your config.',
    );
  }

  if (!base.startsWith('s3://')) {
    throw new PublishError(`An S3 destination must start with s3://, got "${base}"`);
  }

  const prefix = input.uri === undefined ? (input.prefix ?? '') : '';
  return [trimSlashes(base), trimSlashes(prefix), input.fileName]
    .filter((part) => part !== '')
    .join('/');
}

const trimSlashes = (value: string): string => value.replace(/\/+$/, '').replace(/^\/+/, '');
