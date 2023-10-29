import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface AuroraProps {
  vpc: cdk.aws_ec2.IVpc;
}

export class Aurora extends Construct {
  constructor(scope: Construct, id: string, props: AuroraProps) {
    super(scope, id);

    // DB Cluster Parameter Group
    const dbClusterParameterGroup15 = new cdk.aws_rds.ParameterGroup(
      this,
      "DbClusterParameterGroup15",
      {
        engine: cdk.aws_rds.DatabaseClusterEngine.auroraPostgres({
          version: cdk.aws_rds.AuroraPostgresEngineVersion.VER_15_3,
        }),
        description: "aurora-postgresql15",
        parameters: {
          log_statement: "none",
          "pgaudit.log": "all",
          "pgaudit.role": "rds_pgaudit",
          shared_preload_libraries: "pgaudit",
          ssl_ciphers: "TLS_RSA_WITH_AES_256_GCM_SHA384",
        },
      }
    );

    // DB Parameter Group
    const dbParameterGroup15 = new cdk.aws_rds.ParameterGroup(
      this,
      "DbParameterGroup15",
      {
        engine: cdk.aws_rds.DatabaseClusterEngine.auroraPostgres({
          version: cdk.aws_rds.AuroraPostgresEngineVersion.VER_15_3,
        }),
        description: "aurora-postgresql15",
      }
    );

    // Subnet Group
    const subnetGroup = new cdk.aws_rds.SubnetGroup(this, "SubnetGroup", {
      description: "description",
      vpc: props.vpc,
      subnetGroupName: "SubnetGroup",
      vpcSubnets: props.vpc.selectSubnets({
        onePerAz: true,
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    // Monitoring Role
    const monitoringRole = new cdk.aws_iam.Role(this, "MonitoringRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal(
        "monitoring.rds.amazonaws.com"
      ),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonRDSEnhancedMonitoringRole"
        ),
      ],
    });

    // DB Cluster
    const dbCluster = new cdk.aws_rds.DatabaseCluster(this, "Default", {
      engine: cdk.aws_rds.DatabaseClusterEngine.auroraPostgres({
        version: cdk.aws_rds.AuroraPostgresEngineVersion.VER_15_3,
      }),
      writer: cdk.aws_rds.ClusterInstance.provisioned("Writer", {
        instanceType: cdk.aws_ec2.InstanceType.of(
          cdk.aws_ec2.InstanceClass.T3,
          cdk.aws_ec2.InstanceSize.MEDIUM
        ),
        allowMajorVersionUpgrade: false,
        autoMinorVersionUpgrade: true,
        enablePerformanceInsights: true,
        parameterGroup: dbParameterGroup15,
        performanceInsightRetention:
          cdk.aws_rds.PerformanceInsightRetention.DEFAULT,
        publiclyAccessible: false,
        instanceIdentifier: "db-instance-writer",
        caCertificate: cdk.aws_rds.CaCertificate.RDS_CA_RDS4096_G1,
      }),
      readers: [
        cdk.aws_rds.ClusterInstance.provisioned("Reader", {
          instanceType: cdk.aws_ec2.InstanceType.of(
            cdk.aws_ec2.InstanceClass.T3,
            cdk.aws_ec2.InstanceSize.MEDIUM
          ),
          allowMajorVersionUpgrade: false,
          autoMinorVersionUpgrade: true,
          enablePerformanceInsights: true,
          parameterGroup: dbParameterGroup15,
          performanceInsightRetention:
            cdk.aws_rds.PerformanceInsightRetention.DEFAULT,
          publiclyAccessible: false,
          instanceIdentifier: "db-instance-reader",
          caCertificate: cdk.aws_rds.CaCertificate.RDS_CA_RDS4096_G1,
        }),
      ],
      backup: {
        retention: cdk.Duration.days(7),
        preferredWindow: "16:00-16:30",
      },
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      clusterIdentifier: "db-cluster",
      copyTagsToSnapshot: true,
      defaultDatabaseName: "testDB",
      deletionProtection: false,
      iamAuthentication: false,
      monitoringInterval: cdk.Duration.minutes(1),
      monitoringRole,
      parameterGroup: dbClusterParameterGroup15,
      preferredMaintenanceWindow: "Sat:17:00-Sat:17:30",
      storageEncrypted: true,
      storageEncryptionKey: cdk.aws_kms.Alias.fromAliasName(
        this,
        "DefaultRdsKey",
        "alias/aws/rds"
      ),
      vpc: props.vpc,
      subnetGroup,
    });

    const cfnDbCluster = dbCluster.node
      .defaultChild as cdk.aws_rds.CfnDBCluster;

    // Integration Secrets Manager
    cfnDbCluster.manageMasterUserPassword = true;
    cfnDbCluster.masterUsername = "postgres";
    cfnDbCluster.addPropertyDeletionOverride("MasterUserPassword");
    dbCluster.node.tryRemoveChild("Secret");

    const masterUserSecretArn = cfnDbCluster
      .getAtt("MasterUserSecret.SecretArn")
      .toString();

    new cdk.aws_secretsmanager.CfnRotationSchedule(this, "RotationSchedule", {
      secretId: masterUserSecretArn,
      rotationRules: {
        scheduleExpression: "cron(0 10 ? 1/1 7#1 *)",
        duration: "1h",
      },
    });

    // DB Instance PreferredMaintenanceWindow
    const shiftTime = (dayTime: string, shiftMinutes: number) => {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

      const day = dayTime.substring(0, 3);
      const time = dayTime.substring(4);

      const [hour, min] = time.split(":").map(Number);

      const totalMinutes = hour * 60 + min + shiftMinutes;
      const targetHour = Math.floor(totalMinutes / 60) % 24;
      const targetMinutes = totalMinutes % 60;
      const shiftedDays = Math.floor(totalMinutes / (24 * 60));

      const dayIndex = days.indexOf(day);
      const targetDay = days[(dayIndex + shiftedDays) % days.length];

      return [
        `${targetDay}:${targetHour.toString().padStart(2, "0")}:${targetMinutes
          .toString()
          .padStart(2, "0")}`,
      ];
    };

    const generateShiftMaintenanceWindows = (
      baseMaintenanceWindow: string,
      shiftMinutes: number,
      shiftCount: number
    ) => {
      const [baseStartDayTime, baseEndDayTime] =
        baseMaintenanceWindow.split("-");

      return [...Array(shiftCount)].map((_, i) => {
        const startDayTime = shiftTime(
          baseStartDayTime,
          shiftMinutes * (i + 1)
        );
        const endDayTime = shiftTime(baseEndDayTime, shiftMinutes * (i + 1));
        return `${startDayTime}-${endDayTime}`;
      });
    };

    const cfnDbInstances = dbCluster.node.children
      .filter(
        (child) => child.node.defaultChild instanceof cdk.aws_rds.CfnDBInstance
      )
      .map((child) => child.node.defaultChild) as cdk.aws_rds.CfnDBInstance[];

    console.log(
      generateShiftMaintenanceWindows(
        "Sat:17:00-Sat:17:30",
        30,
        cfnDbInstances.length
      )
    );

    const dbInstanceMaintenanceWindows = generateShiftMaintenanceWindows(
      "Sat:17:00-Sat:17:30",
      30,
      cfnDbInstances.length
    ).reverse();

    cfnDbInstances.forEach((cfnDbInstance, i) => {
      cfnDbInstance.addPropertyOverride(
        "PreferredMaintenanceWindow",
        dbInstanceMaintenanceWindows[i]
      );
    });
  }
}
