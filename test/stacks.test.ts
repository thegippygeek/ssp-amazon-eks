import { expect as expectCDK, haveResourceLike } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import { ManualApprovalStep } from '@aws-cdk/pipelines';
import * as ssp from '../lib';
import { MyVpcStack } from './test-support';

describe('Unit tests for EKS Blueprint', () => {

    test('Usage tracking created', () => {
        const app = new cdk.App();
        // WHEN
        let stack = new ssp.EksBlueprint(app, { id: 'MyTestStack' });
        console.log(stack.templateOptions.description);
        // THEN
        assertBlueprint(stack);

        stack = new ssp.EksBlueprint(app, { id: 'MyOtherTestStack' }, {
            description: "My awesome description"
        });

        console.log(stack.templateOptions.description);
        // AND
        assertBlueprint(stack);
    });


    test("Stack creation fails due to missing add-on dependency", () => {
        const app = new cdk.App();

        const blueprint = ssp.EksBlueprint.builder();

        blueprint.account("123567891").region('us-west-1')
            .addOns(new ssp.NginxAddOn)
            .teams(new ssp.PlatformTeam({ name: 'platform' }));

        expect(() => blueprint.build(app, 'stack-with-missing-deps')).toThrow("Missing a dependency for AwsLoadBalancerControllerAddOn for stack-with-missing-deps");
    });

    test("Stack creation fails due to adding Karpenter with Cluster Autoscaler", () => {
        const app = new cdk.App();

        const blueprint = ssp.EksBlueprint.builder();

        blueprint.account("123567891").region('us-west-1')
            .addOns(new ssp.ClusterAutoScalerAddOn, new ssp.KarpenterAddOn)
            .teams(new ssp.PlatformTeam({ name: 'platform' }));

        expect(()=> {
            blueprint.build(app, 'stack-with-conflicting-addons');
        }).toThrow("Deploying stack-with-conflicting-addons failed due to conflicting add-on: ClusterAutoScalerAddOn.");
    });

    test("Stack creation fails due to adding Cluster Autoscaler with Karpenter", () => {
        const app = new cdk.App();

        const blueprint = ssp.EksBlueprint.builder();

        blueprint.account("123567891").region('us-west-1')
            .addOns(new ssp.KarpenterAddOn, new ssp.ClusterAutoScalerAddOn)
            .teams(new ssp.PlatformTeam({ name: 'platform' }));

        expect(()=> {
            blueprint.build(app, 'stack-with-conflicting-addons');
        }).toThrow("Deploying stack-with-conflicting-addons failed due to conflicting add-on: KarpenterAddOn.");
    });

    test("Stack creation fails due to wrong node group type for NTH addon", () => {
        const app = new cdk.App();

        const blueprint = ssp.EksBlueprint.builder();

        blueprint.account("123567891").region('us-west-1')
            .addOns(new ssp.AwsNodeTerminationHandlerAddOn);

        expect(() => blueprint.build(app, 'stack-with-missing-deps')).toThrow('AWS Node Termination Handler is only supported for self-managed nodes');
    });

    test('Blueprint builder creates correct stack', async () => {
        const app = new cdk.App();

        const blueprint = ssp.EksBlueprint.builder();

        blueprint.account("123567891").region('us-west-1')
            .addOns(new ssp.ArgoCDAddOn)
            .addOns(new ssp.AwsLoadBalancerControllerAddOn)
            .addOns(new ssp.NginxAddOn)
            .teams(new ssp.PlatformTeam({ name: 'platform' }));

        const stack1 = await blueprint.buildAsync(app, "stack-1");

        assertBlueprint(stack1, 'nginx-ingress', 'argo-cd');
        const blueprint2 = blueprint.clone('us-west-2', '1234567891').addOns(new ssp.CalicoAddOn);
        const stack2 = await blueprint2.buildAsync(app, 'stack-2');

        assertBlueprint(stack2, 'nginx-ingress', 'argo-cd', 'aws-calico');

        const blueprint3 = ssp.EksBlueprint.builder().withBlueprintProps({
            addOns: [new ssp.ArgoCDAddOn],
            name: 'my-blueprint3',
            id: 'my-blueprint3-id'
        });

        const stack3 = await blueprint3.buildAsync(app, 'stack-3');
        assertBlueprint(stack3, 'argo-cd');
    });

    test('Pipeline Builder Creates correct pipeline', () => {

        const app = new cdk.App();

        const blueprint = ssp.EksBlueprint.builder()
            .account("123567891")
            .region('us-west-1')
            .addOns(new ssp.ArgoCDAddOn)
            .addOns(new ssp.AwsLoadBalancerControllerAddOn)
            .addOns(new ssp.NginxAddOn)
            .teams(new ssp.PlatformTeam({ name: 'platform' }));

        const pipeline = ssp.CodePipelineStack.builder()
            .name("ssp-pipeline-inaction")
            .owner('shapirov103')
            .repository({
                repoUrl: 'git@github',
                credentialsSecretName: 'github-token',
                name: 'my-iac-pipeline'
            })
            .stage({
                id: 'us-east-1-ssp',
                stackBuilder: blueprint.clone('us-east-1'),
            })
            .wave( {
                id: "dev",
                stages: [
                    { id: "dev-east-1", stackBuilder: blueprint.clone('us-east-1').id('dev-east-1')},
                    { id: "dev-east-2", stackBuilder: blueprint.clone('us-east-2').id('dev-east-2')},
                ]
            })
            .stage({
                id: 'us-east-2-ssp',
                stackBuilder: blueprint.clone('us-east-2')
            })
            .wave( {
                id: "test",
                stages: [
                    { id: "test-east-1", stackBuilder: blueprint.clone('us-east-1').id('test-east-1')},
                    { id: "test-east-2", stackBuilder: blueprint.clone('us-east-2').id('test-east-2')},
                ]
            })
            .stage({
                id: 'prod-ssp',
                stackBuilder: blueprint.clone('us-west-2'),
                stageProps: {
                    pre: [new ManualApprovalStep("prod-ssp-approval", { comment: "Approval step for production deployment."})]
                }
            });

        const stack = pipeline.build(app, "ssp-pipeline-id");
        console.log(stack.templateOptions.description);
        expect(stack.templateOptions.description).toContain("SSP tracking (qs");
    });

    test("Nested stack add-on creates correct nested stack", async () => {
        const app = new cdk.App();
        const vpcAddOn = new ssp.NestedStackAddOn( {
            builder: MyVpcStack.builder(),
            id: "vpc-nested-stack"
        });

        const blueprint = ssp.EksBlueprint.builder();

        blueprint.account("123567891").region('us-west-1')
            .addOns(vpcAddOn)
            .teams(new ssp.PlatformTeam({ name: 'platform' }));

        const parentStack =  await blueprint.buildAsync(app, "stack-with-nested");
        const clusterInfo = parentStack.getClusterInfo();
        expect(clusterInfo.getProvisionedAddOn("vpc-nested-stack")).toBeDefined();
    });
});

test("Named resource providers are correctly registered and discovered", async () => {
    const app = new cdk.App();

    const blueprint =  await ssp.EksBlueprint.builder()
        .account('123456789').region('us-west-1')
        .resourceProvider(ssp.GlobalResources.HostedZone, new ssp.ImportHostedZoneProvider('hosted-zone-id1', 'my.domain.com'))
        .resourceProvider(ssp.GlobalResources.Certificate, new ssp.CreateCertificateProvider('domain-wildcard-cert', '*.my.domain.com', ssp.GlobalResources.HostedZone))
        .addOns(new ssp.AwsLoadBalancerControllerAddOn())
        .addOns(new ssp.ExternalDnsAddon({hostedZoneResources: [ssp.GlobalResources.HostedZone]}))
        .addOns(new ssp.NginxAddOn({
            certificateResourceName: ssp.GlobalResources.Certificate,
            externalDnsHostname: 'my.domain.com'
        }))
        .addOns(new ssp.OpaGatekeeperAddOn())
        .teams(new ssp.ApplicationTeam({
            name: "appteam", namespace: "appteam-ns"
        }))
        .buildAsync(app, 'stack-with-resource-providers');
    
    expect(blueprint.getClusterInfo().getResource(ssp.GlobalResources.Vpc)).toBeDefined();
    expect(blueprint.getClusterInfo().getResource(ssp.GlobalResources.HostedZone)).toBeDefined();
    expect(blueprint.getClusterInfo().getResource(ssp.GlobalResources.Certificate)).toBeDefined();
    expect(blueprint.getClusterInfo().getProvisionedAddOn('NginxAddOn')).toBeDefined();
});

function assertBlueprint(stack: ssp.EksBlueprint, ...charts: string[]) {
    for (let chart of charts) {
        expectCDK(stack).to(haveResourceLike('Custom::AWSCDK-EKS-HelmChart', {
            Chart: chart
        }));
    }
    expect(stack.templateOptions.description).toContain("SSP tracking (qs");
}