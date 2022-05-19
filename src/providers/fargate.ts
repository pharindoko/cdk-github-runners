import * as path from 'path';
import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
  aws_stepfunctions as stepfunctions,
  aws_stepfunctions_tasks as stepfunctions_tasks,
} from 'aws-cdk-lib';
import { IntegrationPattern } from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { IRunnerProvider, RunnerProviderProps, RunnerRuntimeParameters, RunnerVersion } from './common';

export interface FargateRunnerProps extends RunnerProviderProps {
  /**
   * GitHub Actions label used for this provider.
   *
   * @default 'fargate'
   */
  readonly label?: string;

  /**
   * VPC to launch the runners in.
   *
   * @default default account VPC
   */
  readonly vpc?: ec2.IVpc;

  /**
   * Security Group to assign to the task.
   *
   * @default a new security group
   */
  readonly securityGroup?: ec2.ISecurityGroup;

  /**
   * Existing Fargate cluster to use.
   *
   * @default a new cluster
   */
  readonly cluster?: ecs.Cluster;

  /**
   * Assign public IP to the runner task.
   *
   * @default true
   */
  readonly assignPublicIp?: boolean;

  /**
   * The number of cpu units used by the task. For tasks using the Fargate launch type,
   * this field is required and you must use one of the following values,
   * which determines your range of valid values for the memory parameter:
   *
   * 256 (.25 vCPU) - Available memory values: 512 (0.5 GB), 1024 (1 GB), 2048 (2 GB)
   *
   * 512 (.5 vCPU) - Available memory values: 1024 (1 GB), 2048 (2 GB), 3072 (3 GB), 4096 (4 GB)
   *
   * 1024 (1 vCPU) - Available memory values: 2048 (2 GB), 3072 (3 GB), 4096 (4 GB), 5120 (5 GB), 6144 (6 GB), 7168 (7 GB), 8192 (8 GB)
   *
   * 2048 (2 vCPU) - Available memory values: Between 4096 (4 GB) and 16384 (16 GB) in increments of 1024 (1 GB)
   *
   * 4096 (4 vCPU) - Available memory values: Between 8192 (8 GB) and 30720 (30 GB) in increments of 1024 (1 GB)
   *
   * @default 1024
   */
  readonly cpu?: number;

  /**
   * The amount (in MiB) of memory used by the task. For tasks using the Fargate launch type,
   * this field is required and you must use one of the following values, which determines your range of valid values for the cpu parameter:
   *
   * 512 (0.5 GB), 1024 (1 GB), 2048 (2 GB) - Available cpu values: 256 (.25 vCPU)
   *
   * 1024 (1 GB), 2048 (2 GB), 3072 (3 GB), 4096 (4 GB) - Available cpu values: 512 (.5 vCPU)
   *
   * 2048 (2 GB), 3072 (3 GB), 4096 (4 GB), 5120 (5 GB), 6144 (6 GB), 7168 (7 GB), 8192 (8 GB) - Available cpu values: 1024 (1 vCPU)
   *
   * Between 4096 (4 GB) and 16384 (16 GB) in increments of 1024 (1 GB) - Available cpu values: 2048 (2 vCPU)
   *
   * Between 8192 (8 GB) and 30720 (30 GB) in increments of 1024 (1 GB) - Available cpu values: 4096 (4 vCPU)
   *
   * @default 2048
   */
  readonly memoryLimitMiB?: number;

  /**
   * The amount (in GiB) of ephemeral storage to be allocated to the task. The maximum supported value is 200 GiB.
   *
   * NOTE: This parameter is only supported for tasks hosted on AWS Fargate using platform version 1.4.0 or later.
   *
   * @default 20
   */
  readonly ephemeralStorageGiB?: number;
}

/**
 * GitHub Actions runner provider using Fargate to execute the actions.
 *
 * Creates a task definition with a single container that gets started for each job.
 */
export class FargateRunner extends Construct implements IRunnerProvider {
  readonly cluster: ecs.Cluster;
  readonly task: ecs.FargateTaskDefinition;
  readonly container: ecs.ContainerDefinition;

  readonly label: string;
  readonly vpc?: ec2.IVpc;
  readonly securityGroup?: ec2.ISecurityGroup;
  readonly assignPublicIp: boolean;
  readonly grantPrincipal: iam.IPrincipal;
  readonly connections: ec2.Connections;

  constructor(scope: Construct, id: string, props: FargateRunnerProps) {
    super(scope, id);

    this.label = props.label || 'fargate';
    this.vpc = props.vpc || ec2.Vpc.fromLookup(this, 'default vpc', { isDefault: true });
    this.securityGroup = props.securityGroup || new ec2.SecurityGroup(this, 'security group', { vpc: this.vpc });
    this.connections = this.securityGroup.connections;
    this.assignPublicIp = props.assignPublicIp || true;
    this.cluster = props.cluster ? props.cluster : new ecs.Cluster(
      this,
      'cluster',
      {
        vpc: this.vpc,
        enableFargateCapacityProviders: true,
      },
    );

    this.task = new ecs.FargateTaskDefinition(
      this,
      'task',
      {
        cpu: props.cpu || 1024,
        memoryLimitMiB: props.memoryLimitMiB || 2048,
        ephemeralStorageGiB: props.ephemeralStorageGiB || 25,
      },
    );
    this.container = this.task.addContainer(
      'runner',
      {
        image: ecs.AssetImage.fromAsset(
          path.join(__dirname, 'docker-images', 'fargate'),
          {
            buildArgs: {
              RUNNER_VERSION: props.runnerVersion ? props.runnerVersion.version : RunnerVersion.latest().version,
            },
          },
        ),
        logging: ecs.AwsLogDriver.awsLogs({
          logGroup: new logs.LogGroup(this, 'logs'),
          streamPrefix: 'runner',
        }),
      },
    );

    this.grantPrincipal = new iam.UnknownPrincipal({ resource: this.task.taskRole });
  }

  getStepFunctionTask(parameters: RunnerRuntimeParameters): stepfunctions.IChainable {
    return new stepfunctions_tasks.EcsRunTask(
      this,
      'Fargate Runner',
      {
        integrationPattern: IntegrationPattern.RUN_JOB, // sync
        taskDefinition: this.task,
        cluster: this.cluster,
        launchTarget: new stepfunctions_tasks.EcsFargateLaunchTarget(),
        assignPublicIp: this.assignPublicIp,
        securityGroups: this.securityGroup ? [this.securityGroup] : undefined,
        containerOverrides: [
          {
            containerDefinition: this.container,
            environment: [
              {
                name: 'RUNNER_TOKEN',
                value: parameters.runnerTokenPath,
              },
              {
                name: 'RUNNER_NAME',
                value: parameters.runnerNamePath,
              },
              {
                name: 'RUNNER_LABEL',
                value: this.label,
              },
              {
                name: 'GITHUB_DOMAIN',
                value: parameters.githubDomainPath,
              },
              {
                name: 'OWNER',
                value: parameters.ownerPath,
              },
              {
                name: 'REPO',
                value: parameters.repoPath,
              },
            ],
          },
        ],
      },
    );
  }
}