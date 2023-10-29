import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { Vpc } from "./constructs/vpc";
import { Aurora } from "./constructs/aurora";

interface AuroraStackProps extends cdk.StackProps {}

export class AuroraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuroraStackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new Vpc(this, "Vpc");

    // Aurora
    new Aurora(this, "Aurora", {
      vpc: vpc.vpc,
    });
  }
}
